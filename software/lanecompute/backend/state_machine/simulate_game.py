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
Also exercises both reset flows after the full game: starting a new game
with the same players (POST .../games again) and a full lane reset that
clears the roster too (POST .../reset).

Usage:
    uv run --with requests python simulate_game.py [--lane 7] [--base http://localhost:8000]
"""

import argparse
import time

import requests

DELAY = 0.9  # pause between deliveries so it's actually watchable

# Frame-by-frame scripts, one entry per frame. Each is a legal ten-pin
# sequence (sum <= 10 within a frame, except a fresh-rack strike -- a
# "second-ball strike" is physically impossible and never appears here).
# Not just hand-verified: game_state.py's record_ball() now rejects any
# pinfall that exceeds what's actually still standing, so an invalid
# sequence here would surface as a 400 from /pinfall, not silently corrupt
# the scoresheet.
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

    def start_new_game_same_players(self) -> None:
        """POST .../games again -- same roster, fresh scoresheet. Not a
        separate endpoint from the first game start; this IS how a lane
        starts its next game with the people already checked in (see
        game_state.LaneState.add_game()'s docstring)."""
        print("\n=== Starting a new game, same players (POST /games again) ===")
        self.post("/games", {"game_type": "ten_pin"})

    def full_reset(self) -> None:
        """POST .../reset -- wipes the roster AND the game, distinct from
        start_new_game_same_players() above. Asserts the wipe actually
        took, not just that the call returned 2xx."""
        print("\n=== Full reset (clears roster + game, for a new party) ===")
        self.post("/reset")
        snap = self.get()
        assert snap["game"] is None, f"expected game=None after reset, got {snap['game']}"
        assert snap["bowlers"] == [], f"expected empty roster after reset, got {snap['bowlers']}"
        assert snap["machineState"] == "IDLE", f"expected IDLE after reset, got {snap['machineState']}"
        print(f"Confirmed wiped: game={snap['game']}, bowlers={snap['bowlers']}, machineState={snap['machineState']}")


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

    print("\n=== Bowling (game 1) ===")
    for frame_no in range(10):
        for balls in (ALICE[frame_no], BOB[frame_no]):
            for ball in balls:
                sim.throw(ball, f"(frame {frame_no + 1})")

    print("\n=== Final scoresheet (game 1) ===")
    sim.print_scoresheet()

    # Same roster, fresh scoresheet -- one quick frame is enough to prove
    # both halves of that: Alice/Bob are still checked in (no re-adding
    # bowlers needed) and their totals reset to just this frame's score,
    # not carried over from game 1.
    sim.start_new_game_same_players()
    print("\n=== Bowling one frame (game 2, same players) ===")
    sim.throw(7, "(frame 1)")
    sim.throw(2, "(frame 1)")
    sim.throw(5, "(frame 1)")
    sim.throw(3, "(frame 1)")
    print("\n=== Scoresheet after one frame of game 2 ===")
    sim.print_scoresheet()

    # Wipes the roster too -- the lane is done with Alice/Bob entirely,
    # as opposed to the same-players restart above.
    sim.full_reset()


if __name__ == "__main__":
    main()
