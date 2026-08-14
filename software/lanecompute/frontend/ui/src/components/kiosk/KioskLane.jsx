import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useLaneFeed } from "../../lib/useLaneFeed.js";
import { KioskThemeProvider, K, useKioskTheme } from "./theme.jsx";
import { LABEL, card, filled, panel } from "./styles.js";
import ActionButton from "./ActionButton.jsx";
import SessionClock from "./SessionClock.jsx";
import RosterModal, { RosterSummary } from "./RosterModal.jsx";
import ScoreEditModal from "./ScoreEditModal.jsx";
import PinPickerModal from "./PinPickerModal.jsx";
import Toasts, { useToasts } from "./Toasts.jsx";
import { AddBowlerModal, ConfirmModal, NumberPadModal, TextPromptModal } from "./Modals.jsx";

/* ═══════════════════════════════════════════════════════════════════
   BOWLER TERMINAL — /kiosk/:laneId

   The lane-side tablet, migrated off openlanescheduler's two-lane kiosk.
   Two things changed in the move, both deliberate:

   1. One lane per device, not a pair. Every other screen in this UI is
      already per-lane (/display/:laneId, /control/:laneId) and the compute
      node's whole API is per-lane; a two-lane terminal would have been the
      only thing here straddling that.
   2. It talks to this compute node, not to the scheduler. The countdown is
      the compute node's own session clock (backend session.py) rather than
      arithmetic over a walk-in record held in another service, so the lane
      keeps working -- and keeps timing correctly -- with the scheduler
      down. Staff are still summoned through the scheduler's existing
      service-call pipeline (backend assistance.py publishes to its MQTT
      topic); that edge is the only thing the two systems still share.

   Every button here is a REST call on that same public API (see
   ../../lib/useLaneFeed.js) -- there is no private kiosk channel, which is
   what lets the siteserver bus activate a lane later and land in exactly
   the state a bowler tapping Start would have produced.

   Three states, in order:
   1. Idle    — no session. Pick hours or games, "Start session".
   2. Roster  — session live, clock running, no scoresheet yet. Enter
                everyone's name, then "Start game".
   3. Playing — the lane screen: who's up, staff calls, pinsetter, extend.
   Step 2 is skipped entirely for an activation that already carried a
   roster (see api.py's LaneActivate.bowlers) -- the game starts with the
   session and the lane goes straight to 3.

   Layout: the shell is one column in portrait and two side-by-side in
   landscape (.k-shell in theme.jsx). Nothing here measures the viewport
   in JS -- a kiosk can be rotated after boot, and CSS handles that without
   a resize listener. Everything that isn't the clock, the current bowler,
   or an action lives behind a modal, so neither orientation has to scroll
   to reach the pinsetter.
   ═══════════════════════════════════════════════════════════════════ */

const TIMED_CHOICES = [30, 60, 90, 120];
const GAME_CHOICES = [1, 2, 3, 4];

function Header({ laneId, connected }) {
  const { scheme, toggle } = useKioskTheme();
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, minWidth: 0 }}>
        <div style={LABEL}>OpenLane</div>
        <div style={{
          fontSize: "clamp(22px, 3.4vmin, 34px)", fontWeight: 800, letterSpacing: 0.5, color: K.text,
        }}>Lane {String(laneId).padStart(2, "0")}</div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <div style={{
          ...card(10), padding: "9px 13px", display: "flex", alignItems: "center", gap: 8,
          fontSize: 12, fontWeight: 700, color: connected ? K.text : K.textDim,
        }}>
          <span aria-hidden="true" style={{
            width: 9, height: 9, borderRadius: 5,
            background: connected ? K.green : K.textFaint,
          }} />
          {connected ? "Online" : "Reconnecting…"}
        </div>
        <button
          className="k-btn"
          onClick={toggle}
          aria-label={`Switch to ${scheme === "light" ? "dark" : "light"} mode`}
          title={`Switch to ${scheme === "light" ? "dark" : "light"} mode`}
          style={{ width: 42, height: 42, borderRadius: 10, fontSize: 17, color: K.textDim, lineHeight: 1 }}
        >{scheme === "light" ? "☾" : "☀"}</button>
      </div>
    </div>
  );
}

function Chip({ label, selected, onClick }) {
  return (
    <button
      className="k-btn"
      onClick={onClick}
      aria-pressed={selected}
      style={{
        flex: 1, padding: "15px 0", fontSize: 15, fontWeight: 800, letterSpacing: 0.3,
        ...(selected ? filled(K.accent, K.accentInk, 12) : { background: K.panel, color: K.text }),
      }}
    >{label}</button>
  );
}

/* Step 1, on an idle lane: what's being bought. "Start session" opens the
   session (the clock starts here) but deliberately does NOT start a game --
   there's nobody on the lane yet to bowl one. See api.py's activate_lane. */
function StartPanel({ onStart }) {
  const [mode, setMode] = useState("timed");
  const [minutes, setMinutes] = useState(60);
  const [games, setGames] = useState(1);

  return (
    <div style={{ ...panel(16), padding: 18 }}>
      <div style={{ ...LABEL, marginBottom: 14 }}>Start bowling</div>

      <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
        <Chip label="By the hour" selected={mode === "timed"} onClick={() => setMode("timed")} />
        <Chip label="By the game" selected={mode === "games"} onClick={() => setMode("games")} />
      </div>

      <div style={{ ...LABEL, marginBottom: 10 }}>{mode === "timed" ? "How long" : "How many games"}</div>
      <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
        {mode === "timed"
          ? TIMED_CHOICES.map((m) => (
              <Chip key={m} label={m >= 60 && m % 60 === 0 ? `${m / 60}h` : `${m}m`}
                    selected={minutes === m} onClick={() => setMinutes(m)} />
            ))
          : GAME_CHOICES.map((g) => (
              <Chip key={g} label={String(g)} selected={games === g} onClick={() => setGames(g)} />
            ))}
      </div>

      <button
        className="k-btn"
        onClick={() => onStart(mode === "timed" ? { mode, minutes } : { mode, games })}
        style={{
          ...filled(K.green, K.greenInk, 14), width: "100%",
          padding: "20px 0", fontSize: 19, fontWeight: 800, letterSpacing: 0.8,
        }}
      >Start session</button>
    </div>
  );
}

/* Open staff calls. Capped and scrolled internally rather than allowed to
   grow: nothing stops a lane accumulating calls (a bowler can tap "call a
   server" as many times as they like), and an unbounded list pushed the
   page past the viewport and put a scrollbar on the whole terminal --
   which moves every other control off screen to show a list of things
   already being dealt with. Two rows visible is enough to see that the
   call registered; the rest scroll in place. */
function OpenCalls({ requests, onClear }) {
  if (requests.length === 0) return null;
  return (
    <div style={{
      ...panel(16), padding: 14, display: "flex", flexDirection: "column", gap: 10,
      flexShrink: 0, minHeight: 0,
    }}>
      <div style={{ ...LABEL, flexShrink: 0 }}>Waiting on staff</div>
      <div style={{
        display: "flex", flexDirection: "column", gap: 10,
        maxHeight: 168, overflowY: "auto", minHeight: 0,
      }}>
      {requests.map((req) => {
        const problem = req.kind === "problem";
        const accent = problem ? K.yellow : K.blue;
        return (
          <div key={req.id} style={{
            ...card(11), padding: "11px 13px", display: "flex", alignItems: "center", gap: 12,
            borderColor: accent,
          }}>
            <span aria-hidden="true" style={{
              width: 10, height: 10, borderRadius: 5, background: accent, flexShrink: 0,
            }} />
            <span style={{ flex: 1, minWidth: 0, fontSize: 15, fontWeight: 700, color: K.text }}>
              {problem ? "Help requested" : "Server requested"}
              {req.reason && <span style={{ color: K.textDim, fontWeight: 600 }}> · {req.reason}</span>}
            </span>
            <button
              className="k-btn"
              onClick={() => onClear(req)}
              style={{ padding: "10px 15px", fontSize: 13, fontWeight: 800, color: K.textDim, flexShrink: 0 }}
            >Clear</button>
          </div>
        );
      })}
      </div>
    </div>
  );
}

function KioskLaneInner() {
  const { laneId } = useParams();
  const { lane, actions } = useLaneFeed(laneId);
  const { toasts, report } = useToasts();

  const [sheet, setSheet] = useState(null);
  const [rosterOpen, setRosterOpen] = useState(false);
  /* Score correction, behind an explicit "Edit score" tap (see
     ScoreEditModal). `editing` null = closed; { bowlerId: null } = the
     pick-a-bowler step; { bowlerId } = that bowler's frame list.
     `correcting` layers the pin picker on top and, when closed, drops back
     to the frame list rather than out of the flow entirely. */
  const [editing, setEditing] = useState(null);
  const [correcting, setCorrecting] = useState(null); // { bowlerId, frameIdx, ballIdx }

  const active = lane.active;
  /* Session open, but no scoresheet has ever been started on it -- the
     "who's playing" step. `gameType` is null only before the session's
     FIRST game; an ended game leaves it set, so finishing a game drops
     back to the normal lane screen with "play another game", not back
     here. */
  const awaitingRoster = active && lane.gameType == null;

  /* "Is there a scoresheet being bowled right now" -- distinct from the
     lane being active. A finished game (every bowler through the 10th) is
     still the current game until somebody starts the next one, but the
     terminal should be offering that next game rather than an End button
     for a game nobody can throw into. */
  const gameInProgress = active
    && lane.gameType != null
    && !lane.gameEnded
    && lane.machineState !== "GAME_COMPLETE";

  const closeSheet = () => setSheet(null);

  const extendLabel = lane.session?.mode === "games"
    ? { label: "Play another game", sublabel: "Adds one game" }
    : { label: "Extend time", sublabel: "Add more time" };

  const startLabel = lane.machineState === "GAME_COMPLETE" || lane.gameEnded
    ? { label: "Play another game", sublabel: "New scoresheet" }
    : { label: "Start game", sublabel: null };

  const bowlers = useMemo(() => lane.bowlers ?? [], [lane.bowlers]);
  // Both looked up by id against the live roster on every render rather
  // than captured into state: the snapshot changes under the modal with
  // every ball thrown, and a captured copy would show a stale scoresheet
  // to the one person actively trying to correct it.
  const editingBowler = editing?.bowlerId ? bowlers.find((b) => b.id === editing.bowlerId) : null;
  const correctingBowler = correcting ? bowlers.find((b) => b.id === correcting.bowlerId) : null;

  const rosterProps = {
    bowlers,
    maxBowlers: lane.maxBowlers,
    currentBowlerId: lane.currentBowlerId,
    onAdd: () => setSheet({ kind: "addBowler" }),
    onRename: (bowler) => setSheet({ kind: "renameBowler", bowler }),
    onHandicap: (bowler) => setSheet({ kind: "handicap", bowler }),
    onRemove: (bowler) => setSheet({ kind: "removeBowler", bowler }),
    onSetTurn: (bowler) => report(actions.setCurrentBowler(bowler.id), `${bowler.name} is up`),
  };

  // Only the playing state has a second column to fill; idle and the
  // "who's playing" step (whose content is in a modal) are one column, and
  // a landscape grid would strand them against empty background.
  const twoColumn = active && !awaitingRoster;

  return (
    <>
      <div className={`k-shell${twoColumn ? "" : " k-shell--solo"}`}>
        <div className="k-block k-block--status">
          <Header laneId={laneId} connected={lane.connected} />
          <SessionClock session={lane.session} active={active} held={lane.awaitingStaff} />
          <OpenCalls
            requests={lane.assistance}
            onClear={(req) => report(actions.resolveAssistance(req.id), "Call cleared")}
          />
          {!active && <StartPanel onStart={(opts) => report(actions.activateLane(opts), "Session started")} />}
        </div>

        {active && !awaitingRoster && (
          <>
            {/* The game: who's up, and everything that acts on the
                scoresheet or the machine. */}
            <div className="k-block k-block--game">
              <RosterSummary
                bowlers={bowlers}
                currentBowlerId={lane.currentBowlerId}
                onOpen={() => setRosterOpen(true)}
              />

              <div className="k-actions">
                <ActionButton
                  glyph="👤" label="Bowlers" sublabel="Names, turn & handicaps"
                  onClick={() => setRosterOpen(true)}
                />

                <ActionButton
                  glyph="✎" label="Edit score" sublabel="Fix a wrong frame"
                  disabled={bowlers.length === 0}
                  onClick={() => setEditing({ bowlerId: null })}
                />

                <ActionButton
                  glyph="⚙" label="Cycle pinsetter" sublabel="Reset the pins"
                  onClick={() => report(actions.cyclePinsetter(), "Pinsetter cycling…")}
                />

                <ActionButton
                  glyph="⟳" label="Re-rack" sublabel="Full fresh rack"
                  onClick={() => report(actions.rerackPinsetter(), "Re-racking…")}
                />
              </div>
            </div>

            {/* The session: the lane itself rather than the game on it.
                Sits under the clock in landscape (see .k-shell's grid
                areas), because these are the controls that act on the
                thing the clock is counting. */}
            <div className="k-block k-block--session">
              <div className="k-actions">
                <ActionButton
                  glyph="⏱" label={extendLabel.label} sublabel={extendLabel.sublabel}
                  onClick={() => report(
                    actions.extendSession(lane.session?.mode === "games" ? { games: 1 } : {}),
                    lane.session?.mode === "games" ? "Another game added" : "More time added"
                  )}
                />

                {gameInProgress ? (
                  <ActionButton
                    glyph="⏹" label="End game" sublabel="Keeps your lane"
                    onClick={() => setSheet({ kind: "endGame" })}
                  />
                ) : (
                  <ActionButton
                    glyph="▶" label={startLabel.label} sublabel={startLabel.sublabel}
                    accent={{ fill: K.green, ink: K.greenInk }}
                    disabled={bowlers.length === 0}
                    onClick={() => report(actions.startGame(), "New game started")}
                  />
                )}

                <ActionButton
                  glyph="⚠" label="Call for help" sublabel="Stops your clock"
                  accent={{ fill: K.yellow, ink: K.yellowInk }}
                  disabled={lane.awaitingStaff}
                  onClick={() => report(actions.requestAssistance("problem"), "Help is on the way")}
                />

                <ActionButton
                  glyph="🔔" label="Call a server" sublabel="Food & drinks"
                  onClick={() => report(actions.requestAssistance("service"), "A server is on the way")}
                />

                <button
                  className="k-btn k-actions-wide"
                  onClick={() => setSheet({ kind: "endSession" })}
                  style={{ padding: "16px 0", fontSize: 15, fontWeight: 800, letterSpacing: 0.5, color: K.textDim }}
                >End session</button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Step 2 is the roster modal itself, opened and held open -- the
          "who's playing" step and mid-session roster edits are the same
          list and the same calls, differing only in the footer. */}
      {awaitingRoster && (
        <RosterModal
          {...rosterProps}
          startMode
          onStartGame={() => report(actions.startGame(), "Good luck!")}
          onEndSession={() => setSheet({ kind: "endSession" })}
          onClose={() => setSheet({ kind: "endSession" })}
        />
      )}

      {rosterOpen && !awaitingRoster && (
        <RosterModal {...rosterProps} onClose={() => setRosterOpen(false)} />
      )}

      {editing && (
        <ScoreEditModal
          bowlers={bowlers}
          currentBowlerId={lane.currentBowlerId}
          selectedBowler={editingBowler}
          onPickBowler={(bowler) => setEditing({ bowlerId: bowler.id })}
          onPickFrame={(frameIdx, ballIdx) => setCorrecting({ bowlerId: editing.bowlerId, frameIdx, ballIdx })}
          onBack={() => setEditing({ bowlerId: null })}
          onClose={() => { setEditing(null); setCorrecting(null); }}
        />
      )}

      {correctingBowler && (
        <PinPickerModal
          bowler={correctingBowler}
          frameIdx={correcting.frameIdx}
          ballIdx={correcting.ballIdx}
          /* pinMask must be forwarded, not dropped: it's what populates
             frames[].pinMasks, and without it a later ball in the same
             frame has no way to know which pins are already down.

             Accepting an edit closes the whole flow, back to the lane
             screen — not just the picker. Correcting a score is a task
             someone came here to do; once it's done they want the lane
             again, not to be left holding the frame list they passed
             through to get here. Dismissing the picker with ✕ still drops
             back to that list, because that's a change of mind mid-task,
             not the end of one. */
          onCommit={(frameIdx, ballIdx, pins, pinMask) => {
            report(actions.correctBall(correctingBowler.id, frameIdx, ballIdx, pins, pinMask), "Score updated");
            setCorrecting(null);
            setEditing(null);
          }}
          onClose={() => setCorrecting(null)}
        />
      )}

      {sheet?.kind === "addBowler" && (
        <AddBowlerModal
          onCommit={(name, handicap) => report(
            actions.addBowler(name, handicap),
            handicap > 0 ? `${name} added (+${handicap})` : `${name} added`
          )}
          onClose={closeSheet}
        />
      )}

      {sheet?.kind === "renameBowler" && (
        <TextPromptModal
          title="Bowler name" label="Name" initial={sheet.bowler.name}
          onCommit={(name) => report(actions.renameBowler(sheet.bowler.id, name), "Name updated")}
          onClose={closeSheet}
        />
      )}

      {sheet?.kind === "handicap" && (
        <NumberPadModal
          title={`Handicap — ${sheet.bowler.name}`} initial={sheet.bowler.handicap ?? 0}
          onCommit={(value) => report(actions.setHandicap(sheet.bowler.id, value), "Handicap saved")}
          onClose={closeSheet}
        />
      )}

      {sheet?.kind === "removeBowler" && (
        <ConfirmModal
          title="Remove bowler" danger confirmLabel="Remove"
          message={`Remove ${sheet.bowler.name} from this lane? Their score for this game goes with them.`}
          onConfirm={() => report(actions.removeBowler(sheet.bowler.id), `${sheet.bowler.name} removed`)}
          onClose={closeSheet}
        />
      )}

      {sheet?.kind === "endGame" && (
        <ConfirmModal
          title="End game" confirmLabel="End game"
          message="End this game? Your final scores stay on screen and you keep the lane — you can start another game whenever you're ready."
          onConfirm={() => report(actions.endGame(), "Game ended")}
          onClose={closeSheet}
        />
      )}

      {sheet?.kind === "endSession" && (
        <ConfirmModal
          title="End session" danger confirmLabel="End session"
          message="Finished for the day? This hands the lane back and clears the scoreboard. Staff will need to set it up again."
          onConfirm={() => { setRosterOpen(false); report(actions.deactivateLane(), "Thanks for bowling!"); }}
          onClose={closeSheet}
        />
      )}

      <Toasts toasts={toasts} />
    </>
  );
}

export default function KioskLane() {
  return (
    <KioskThemeProvider>
      <KioskLaneInner />
    </KioskThemeProvider>
  );
}
