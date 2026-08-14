import { K, useTwoColumn } from "./theme.jsx";
import { displayTotal } from "../../lib/scoring.js";
import { LABEL, MONO, card, panel, sunken } from "./styles.js";
import Modal, { ModalButton } from "./Modal.jsx";

/* Managing who's on the lane, in its own dialog.

   The roster used to be a permanent panel on the main screen. With up to
   twelve bowlers, each needing a name, a handicap and a remove control,
   that panel pushed everything a bowler actually reaches for -- the
   pinsetter, the staff calls, the clock -- off the bottom of a portrait
   console. Editing the roster is something a party does at the start and
   then rarely; it doesn't deserve permanent residency. The main screen
   keeps a one-line summary (RosterSummary below) and this opens on demand.

   Also used, with `startMode`, as the "who's playing" step before a
   session's first game -- same list, same calls, different footer. The
   roster is real lane state in both cases: the session already exists by
   the time either is reachable. */

function BowlerRow({ bowler, isUp, onRename, onHandicap, onRemove, onSetTurn }) {
  const handicap = bowler.handicap ?? 0;
  /* currentFrame is null once this bowler's own game is complete (API.md
     §3.1). The backend refuses to hand the turn to someone with no frames
     left -- it would wedge the lane -- so don't offer it. */
  const finished = bowler.currentFrame == null;
  return (
    <div style={{
      ...card(12),
      padding: "10px 12px",
      display: "flex",
      alignItems: "center",
      gap: 10,
      ...(isUp ? { borderColor: K.accent } : null),
    }}>
      <button
        className="k-btn"
        onClick={onRename}
        style={{
          flex: 1, minWidth: 0, background: "none", border: "none", padding: "6px 2px",
          textAlign: "left", display: "flex", flexDirection: "column", gap: 3,
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
          {isUp && (
            <span
              aria-label="up next"
              style={{ width: 8, height: 8, borderRadius: 4, background: K.accent, flexShrink: 0 }}
            />
          )}
          <span style={{
            fontSize: 17, fontWeight: 700, color: K.text,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>{bowler.name}</span>
        </span>
        {bowler.totalScore != null && (
          <span style={{ fontFamily: MONO, fontSize: 12, color: K.textDim }}>
            {bowler.totalScore}
            {handicap > 0 && <span style={{ color: K.green }}> → {bowler.totalWithHandicap}</span>}
          </span>
        )}
      </button>

      {/* Whose turn it is. Filled and inert for whoever's already up;
          tapping anyone else hands them the turn. Only offered once a game
          exists (onSetTurn is omitted during setup) -- there's no rotation
          to reassign before then. */}
      {onSetTurn && (
        <button
          className="k-btn"
          onClick={isUp || finished ? undefined : onSetTurn}
          disabled={isUp || finished}
          aria-label={isUp ? `${bowler.name} is up` : `Give the turn to ${bowler.name}`}
          title={finished ? "Finished their game" : isUp ? "Up now" : "Give them the turn"}
          style={{
            padding: "7px 11px", minWidth: 54, flexShrink: 0,
            display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
            ...(isUp ? { background: K.accent, borderColor: K.accent, color: K.accentInk } : null),
          }}
        >
          <span aria-hidden="true" style={{ fontSize: 13, lineHeight: 1 }}>▶</span>
          <span style={{
            ...LABEL, fontSize: 9, letterSpacing: 1.2,
            color: isUp ? K.accentInk : K.textFaint,
          }}>{isUp ? "Up" : "Set"}</span>
        </button>
      )}

      <button
        className="k-btn"
        onClick={onHandicap}
        aria-label={`Handicap for ${bowler.name}`}
        style={{
          padding: "7px 11px", minWidth: 66, flexShrink: 0,
          display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
          ...(handicap > 0 ? { borderColor: K.green } : null),
        }}
      >
        <span style={{ ...LABEL, fontSize: 9, letterSpacing: 1.2 }}>Hdcp</span>
        <span style={{
          fontFamily: MONO, fontSize: 15, fontWeight: 800, lineHeight: 1,
          color: handicap > 0 ? K.green : K.textFaint,
        }}>{handicap > 0 ? `+${handicap}` : "—"}</span>
      </button>

      <button
        className="k-btn"
        onClick={onRemove}
        aria-label={`Remove ${bowler.name}`}
        style={{
          width: 42, height: 42, borderRadius: 21, flexShrink: 0,
          fontSize: 18, color: K.textDim, lineHeight: 1,
        }}
      >×</button>
    </div>
  );
}

export default function RosterModal({
  bowlers,
  maxBowlers,
  currentBowlerId,
  startMode = false,
  onAdd,
  onRename,
  onHandicap,
  onRemove,
  onSetTurn,
  onStartGame,
  onEndSession,
  onClose,
}) {
  const full = bowlers.length >= maxBowlers;
  const ready = bowlers.length > 0;

  return (
    <Modal
      title={startMode ? "Who's bowling?" : "Bowlers"}
      onClose={onClose}
      maxWidth={520}
      footer={startMode ? (
        <>
          <ModalButton onClick={onEndSession}>End session</ModalButton>
          <ModalButton tone="green" wide disabled={!ready} onClick={onStartGame}>
            {ready
              ? `Start game — ${bowlers.length} ${bowlers.length === 1 ? "bowler" : "bowlers"}`
              : "Add a bowler to start"}
          </ModalButton>
        </>
      ) : (
        <ModalButton tone="accent" wide onClick={onClose}>Done</ModalButton>
      )}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={LABEL}>{startMode ? "On this lane" : "Roster"}</div>
        <div style={{ ...LABEL, color: K.textDim }}>{bowlers.length} / {maxBowlers}</div>
      </div>

      {bowlers.length === 0 ? (
        <div style={{
          ...sunken(12), padding: "28px 16px", textAlign: "center",
          color: K.textDim, fontSize: 15, lineHeight: 1.5,
        }}>
          Add everyone's name — you can change them later.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {bowlers.map((b) => (
            <BowlerRow
              key={b.id}
              bowler={b}
              isUp={b.id === currentBowlerId}
              onRename={() => onRename(b)}
              onHandicap={() => onHandicap(b)}
              onRemove={() => onRemove(b)}
              onSetTurn={startMode ? undefined : () => onSetTurn(b)}
            />
          ))}
        </div>
      )}

      <button
        className="k-btn"
        onClick={full ? undefined : onAdd}
        disabled={full}
        style={{
          width: "100%", marginTop: 12, padding: "15px 0",
          fontSize: 15, fontWeight: 800, letterSpacing: 0.5,
          ...(full ? null : { borderColor: K.lineStrong }),
        }}
      >{full ? `Lane full (${maxBowlers} max)` : "+ Add bowler"}</button>
    </Modal>
  );
}

/* What the main screen shows instead of the full roster. Two shapes, and
   which one you get is a genuine structural difference rather than a
   styling one -- hence useTwoColumn() rather than a media query:

   - PORTRAIT: one tappable line. Who's up, their score, tap to manage.
     Everything below it (the game actions, the session controls) has to
     stay reachable without scrolling on a tall narrow console, so the
     summary gets a line and no more.
   - LANDSCAPE: the full standings panel. There's a whole column to fill
     and .k-grow makes this the element that fills it, so the extra height
     buys real information -- every bowler's frame, handicap and total --
     instead of stretched whitespace. That's also what makes the two
     columns end level (see theme.jsx).

   Scores are whatever the game is decided on: handicapped where a handicap
   exists, scratch otherwise, with the handicap shown alongside so two
   bowlers on the same number aren't mistaken for tied. Same rule
   everywhere -- see displayTotal() in lib/scoring.js. */
export function RosterSummary({ bowlers, currentBowlerId, onOpen }) {
  const twoColumn = useTwoColumn();
  const up = bowlers.find((b) => b.id === currentBowlerId);
  // Highest displayed total, for the leader marker. Ties all get it.
  const leadScore = bowlers.length ? Math.max(...bowlers.map(displayTotal)) : 0;

  if (!twoColumn) {
    const others = bowlers.filter((b) => b.id !== currentBowlerId);
    return (
      <button
        className="k-btn"
        onClick={onOpen}
        style={{
          background: K.panel, borderRadius: 16, padding: "14px 16px",
          display: "flex", alignItems: "center", gap: 14, textAlign: "left", width: "100%",
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ ...LABEL, marginBottom: 5 }}>
            {up ? "Up now" : `${bowlers.length} ${bowlers.length === 1 ? "bowler" : "bowlers"}`}
          </div>
          <div style={{
            fontSize: 20, fontWeight: 800, color: K.text, letterSpacing: 0.3,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>
            {up ? up.name : bowlers.map((b) => b.name).join(", ") || "Nobody yet"}
          </div>
          {up && others.length > 0 && (
            <div style={{
              fontSize: 13, color: K.textDim, marginTop: 3,
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            }}>then {others.map((b) => b.name).join(", ")}</div>
          )}
        </div>

        {up && (
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div style={{ ...LABEL, marginBottom: 3 }}>Score</div>
            <div style={{ fontFamily: MONO, fontSize: 26, fontWeight: 800, color: K.text, lineHeight: 1 }}>
              {displayTotal(up)}
            </div>
            {up.handicap > 0 && (
              <div style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: K.green, marginTop: 2 }}>
                +{up.handicap}
              </div>
            )}
          </div>
        )}

        <span aria-hidden="true" style={{ fontSize: 20, color: K.textFaint, flexShrink: 0 }}>›</span>
      </button>
    );
  }

  return (
    <div className="k-grow" style={{
      ...panel(16), padding: "14px 16px",
      display: "flex", flexDirection: "column", gap: 12, minHeight: 0,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ ...LABEL, marginBottom: 5 }}>
            {up ? "Up now" : `${bowlers.length} ${bowlers.length === 1 ? "bowler" : "bowlers"}`}
          </div>
          <div style={{
            fontSize: 22, fontWeight: 800, color: K.text, letterSpacing: 0.3,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>{up ? up.name : "Nobody yet"}</div>
          {up?.currentFrame != null && (
            <div style={{ fontSize: 13, color: K.textDim, marginTop: 3 }}>
              Frame {up.currentFrame} · ball {up.currentBall}
            </div>
          )}
        </div>

        {up && (
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div style={{ ...LABEL, marginBottom: 3 }}>Score</div>
            <div style={{ fontFamily: MONO, fontSize: 30, fontWeight: 800, color: K.text, lineHeight: 1 }}>
              {displayTotal(up)}
            </div>
            {up.handicap > 0 && (
              <div style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, color: K.green, marginTop: 3 }}>
                {up.totalScore} +{up.handicap}
              </div>
            )}
          </div>
        )}

        <button
          className="k-btn"
          onClick={onOpen}
          aria-label="Manage bowlers"
          style={{ padding: "10px 14px", fontSize: 13, fontWeight: 800, color: K.textDim, flexShrink: 0 }}
        >Manage ›</button>
      </div>

      {bowlers.length > 1 && (
        <>
          <div style={{ height: 1, background: K.line, flexShrink: 0 }} />
          <div style={{ ...LABEL, flexShrink: 0 }}>Standings</div>
          <div style={{
            display: "flex", flexDirection: "column", gap: 6,
            overflowY: "auto", minHeight: 0, flex: 1,
          }}>
            {bowlers.map((b) => {
              const isUp = b.id === currentBowlerId;
              const total = displayTotal(b);
              return (
                <div key={b.id} style={{
                  ...card(10), padding: "9px 11px",
                  display: "flex", alignItems: "center", gap: 10,
                  ...(isUp ? { borderColor: K.accent } : null),
                }}>
                  <span style={{
                    flex: 1, minWidth: 0, fontSize: 15, fontWeight: 700, color: K.text,
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  }}>
                    {total === leadScore && bowlers.length > 1 && (
                      <span aria-label="leading" style={{ color: K.yellow, marginRight: 6 }}>★</span>
                    )}
                    {b.name}
                  </span>
                  <span style={{ ...LABEL, fontSize: 10, color: K.textFaint, flexShrink: 0 }}>
                    {b.currentFrame == null ? "Done" : `F${b.currentFrame}`}
                  </span>
                  {b.handicap > 0 && (
                    <span style={{
                      fontFamily: MONO, fontSize: 12, fontWeight: 700, color: K.green, flexShrink: 0,
                    }}>+{b.handicap}</span>
                  )}
                  <span style={{
                    fontFamily: MONO, fontSize: 20, fontWeight: 800, color: K.text,
                    minWidth: 46, textAlign: "right", flexShrink: 0,
                  }}>{total}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
