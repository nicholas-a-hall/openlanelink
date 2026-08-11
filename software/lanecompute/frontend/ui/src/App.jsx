import { Routes, Route, Link } from "react-router-dom";
import DisplayLanePage from "./components/display/DisplayLanePage.jsx";
import ControlLane from "./components/control/ControlLane.jsx";
import { T } from "./lib/theme.js";

const LANES = [1, 2, 3, 4, 5, 6, 7, 8];

function DevIndex() {
  return (
    <div style={{
      minHeight: "100vh", background: T.bg, color: T.text,
      fontFamily: "system-ui,sans-serif", padding: 32,
    }}>
      <h1 style={{ marginBottom: 4 }}>OpenLane Scheduler — dev index</h1>
      <p style={{ color: T.muted, marginBottom: 24 }}>
        Each lane's monitor and control tablet are separate URLs — this page is a dev-only
        launcher, not part of the real deployment (each device will be pointed straight at
        its own /display/:laneId or /control/:laneId).
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(160px,1fr))", gap: 16 }}>
        {LANES.map((id) => (
          <div key={id} style={{ background: T.raised, border: `1px solid ${T.border}`, borderRadius: 10, padding: 16 }}>
            <div style={{ fontWeight: 700, marginBottom: 10 }}>Lane {id}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <Link to={`/display/${id}`} style={{ color: T.blue }}>Display</Link>
              <Link to={`/control/${id}`} style={{ color: T.yellow }}>Control</Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<DevIndex />} />
      <Route path="/display/:laneId" element={<DisplayLanePage />} />
      <Route path="/control/:laneId" element={<ControlLane />} />
    </Routes>
  );
}
