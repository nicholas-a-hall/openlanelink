// Which physical lanes this installation actually has, driven by the
// LANES env var (comma-separated, e.g. "7,8" for a single gateway pair) --
// defaults to a full 8-lane house so nothing changes for a deployment that
// doesn't set it. Single source of truth for the backend process (server.js,
// pmScheduler.js) -- the frontend/kiosk apps and mqtt-bridge are separate
// deployable processes and parse their own copy of VITE_LANES/LANES the
// same way, since there's no shared package to import this from across
// them.
function parseLanes(raw) {
  if (!raw) return [1, 2, 3, 4, 5, 6, 7, 8];
  const lanes = raw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n) && n > 0);
  if (lanes.length === 0) {
    throw new Error(`LANES env var set but no valid lane numbers parsed from "${raw}"`);
  }
  return lanes;
}

const LANES = parseLanes(process.env.LANES);

module.exports = { LANES, parseLanes };
