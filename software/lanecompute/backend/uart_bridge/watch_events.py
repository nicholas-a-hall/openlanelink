"""Watch this bridge's WS /events feed live -- every decoded LaneEvent/
BeamEvent/StatusEvent, one JSON line per message, as they arrive.

Usage:
    uv run watch_events.py [--url ws://localhost:8100/events]
"""

import argparse
import asyncio

import websockets


async def watch(url: str) -> None:
    async with websockets.connect(url) as ws:
        print(f"-- subscribed to {url} (Ctrl+C to stop) --")
        async for message in ws:
            print(message)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default="ws://localhost:8100/events", help="bridge WS /events URL")
    args = parser.parse_args()
    try:
        asyncio.run(watch(args.url))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
