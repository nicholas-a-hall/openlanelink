"""Simulates a full ten-pin game against a live compute-node API instance,
using the beam/pinfall/cycle-complete endpoints as a stand-in for the
gateway's UART events -- exactly the same calls main.py's UartBridge
callbacks trigger from real hardware, just issued over HTTP instead of
coming off a serial port (see api.py's "Mesh sensor events" section).

Point the UI at the lane you run this against (e.g.
http://localhost:5173/control/7) to watch it unfold live -- no reload
needed, the WebSocket broadcast pushes every state change as it happens.

Not a test suite (see game_state.py/state_machine.py for those) -- this is
for eyeballing the real API + UI wiring end to end with a realistic game.

Usage:
    uv run --with requests python simulate_game.py [--lane 7] [--base http://localhost:8000]
"""

import argparse
import time

import requests

DELAY = 0.9  # pause between deliveries so it's actually watchable

# Frame-by-frame scripts, one entry per frame. Each is already a legal
# ten-pin sequence (sum <= 10 within a frame, except a fresh-rack strike).
ALICE = [
    [10], [7, 2], [9, 1], [10], [10],
    [6, 3], [10], [8, 2], [10], [10, 10, 10],
]
BOB = [
    [5, 3], [8, 1], [10], [4, 4], [6, 2],
    [10], [7, 3], [5, 4], [9, 0], [8, 1],
]


class GameSimulator:
    def __init__(self, base_url: str, lane: int):
        self.base = f"{base_url}/api/lanes/{lane}"

    def post(self, path, body=None):
        r = requests.post(f"{self.base}{path}", json=body or {})
        ok = r.status_code < 300
        body_repr = r.json() if r.headers.get("content-type", "").startswith("application/json") else r.text
        print(f"  {'OK ' if ok else 'ERR'} POST {path} {body or ''} -> {r.status_code} {body_repr}")
        r.raise_for_status()
        return r.json()

    def get(self):
        r = requests.get(self.base)
        r.raise_for_status()
        return r.json()

    def throw(self, pins: int, label: str = "") -> None:
        """One full delivery: upstream beam, downstream beam, pinfall, cycle complete."""
        snap = self.get()
        up = next((b["name"] for b in snap["bowlers"] if b["id"] == snap["currentBowlerId"]), "?")
        print(f"-- {up} throws {pins}{(' ' + label) if label else ''} (state={snap['machineState']})")
        self.post("/beam", {"role": "upstream"})
        time.sleep(0.15)
        self.post("/beam", {"role": "downstream"})
        time.sleep(0.15)
        self.post("/pinfall", {"pinfall": pins})
        time.sleep(0.15)
        self.post("/cycle-complete")
        time.sleep(DELAY)

    def ensure_game_started(self, timeout_s: float = 10.0) -> None:
        """A connected UI auto-starts a game once bowlers exist on an idle
        lane (see useLaneFeed.js). Wait for that; fall back to starting it
        directly if nothing's connected to do it."""
        waited = 0.0
        while waited < timeout_s:
            snap = self.get()
            if snap["machineState"] != "IDLE":
                print(f"Game started: {snap['game']}")
                return
            time.sleep(0.5)
            waited += 0.5
        print("No UI connected to auto-start -- starting the game directly.")
        self.post("/games", {"game_type": "ten_pin"})

    def print_scoresheet(self) -> None:
        final = self.get()
        print(f"machineState: {final['machineState']}")
        for b in final["bowlers"]:
            frames_str = " | ".join(
                f"{f['balls']}={f['frameScore'] if f['frameScore'] is not None else '?'}" for f in b["frames"]
            )
            total = next((f["runningTotal"] for f in reversed(b["frames"]) if f["runningTotal"] is not None), 0)
            print(f"{b['name']}: {frames_str}  => TOTAL {total}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base", default="http://localhost:8000", help="compute-node API base URL")
    parser.add_argument("--lane", type=int, default=7, help="lane number to simulate (must be VALID_LANES in api.py)")
    args = parser.parse_args()

    sim = GameSimulator(args.base, args.lane)

    print("=== Adding bowlers ===")
    sim.post("/bowlers", {"name": "Alice"})
    sim.post("/bowlers", {"name": "Bob"})

    print("=== Waiting for a game to start ===")
    sim.ensure_game_started()

    print("\n=== Bowling ===")
    for frame_no in range(10):
        for balls in (ALICE[frame_no], BOB[frame_no]):
            for ball in balls:
                sim.throw(ball, f"(frame {frame_no + 1})")

    print("\n=== Final scoresheet ===")
    sim.print_scoresheet()


if __name__ == "__main__":
    main()
