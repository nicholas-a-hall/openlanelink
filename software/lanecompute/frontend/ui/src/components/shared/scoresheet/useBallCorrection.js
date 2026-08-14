import { useMemo, useState } from "react";

/* The rules behind a tap-a-frame score correction, with no opinion about
   how it looks.

   Headless because the two screens that correct scores no longer share a
   visual system: the control tablet is neumorphic Midnight Arcade, the
   bowler terminal is the flat high-contrast kiosk theme. Sharing the
   rendered modal meant one of them had to look wrong; sharing nothing
   meant two copies of the pin-count rules. This is the part that's
   genuinely the same -- which ball you're on, how many pins can legally be
   selected for it, and what advancing does -- and each screen draws its
   own pin deck around it.

   Ten pins are hardcoded here, as they are in both pin decks: the backend
   supports duckpin (game_types.py) but no pin-picker UI has been adapted
   for a variable regular-frame ball count yet. See HANDOFF.md's known gaps.
*/

export const PIN_ROWS = [[7, 8, 9, 10], [4, 5, 6], [2, 3], [1]];

const FULL_RACK = 10;

/* Which pins are already down going into ball `ballIdx` of this frame,
   as a Set of pin numbers — or null when it genuinely can't be known.

   Mirrors the backend's own derivation (game_state.py's
   standing_mask_before_next_ball): walk the frame's earlier balls ORing
   their masks, and reset to a full rack after any clear, because a cleared
   rack is respotted and the next ball faces all ten again.

   null, not an empty set, when an earlier ball has no per-pin detail
   (`pinMasks[i] == null` — a foul, a bare-count entry, a ball recorded
   before the pickers started sending masks). Unknown is not "nothing fell",
   and greying out nothing while claiming to know would be worse than
   admitting we don't. */
export function pinsDownBefore(frame, ballIdx) {
  const balls = frame?.balls || [];
  const masks = frame?.pinMasks || [];
  let down = 0;
  let total = 0;
  for (let i = 0; i < ballIdx && i < balls.length; i++) {
    total += balls[i];
    if (total >= FULL_RACK) {
      down = 0;      // cleared — fresh rack for whatever comes next
      total = 0;
      continue;
    }
    if (masks[i] == null) return null;
    down |= masks[i];
  }
  const set = new Set();
  for (let p = 0; p < 10; p++) if ((down >> p) & 1) set.add(p + 1);
  return set;
}

/* Set of pin numbers -> the bitmask the backend stores (bit N-1 = pin N). */
export function pinsToMask(pins) {
  let mask = 0;
  for (const pin of pins) mask |= 1 << (pin - 1);
  return mask;
}

/* `ballIdx` is chosen by the caller, not walked internally.

   This used to open at ball 1 and step forward through the frame,
   committing each one, and it only closed after the last. That made
   correcting a single ball a multi-step chore: fixing ball 1 meant sitting
   through ball 2 as well, and it stole the ball-2 slot to do it. The
   caller now says which ball is being corrected and gets one edit, then
   the picker closes. Reaching ball 2 is picking ball 2. */
export function useBallCorrection({ bowler, frameIdx, ballIdx = 0, onCommit, onClose }) {
  const frame = bowler.frames[frameIdx]?.balls || [];

  const [knocked, setKnocked] = useState(() => new Set());

  /* Pins an earlier ball in this frame already took down. The picker greys
     these out so the same pin can't be counted twice — which the backend
     also refuses (game_state._validate_frame_masks), but a control that
     lets you make an impossible selection and only complains on submit is
     a worse control. null = not derivable; the picker then constrains
     nothing, which is the old behaviour. */
  const alreadyDown = useMemo(
    () => pinsDownBefore(bowler.frames[frameIdx], ballIdx),
    [bowler.frames, frameIdx, ballIdx]
  );

  /* How many pins this ball can legally take, and whether it faces a fresh
     rack. Same reset-on-clear walk the backend uses: a cleared rack is
     respotted, so the ball after a strike (or after a spare in the tenth)
     starts from ten again.

     `freshRack` is what decides whether clearing is a STRIKE or a SPARE.
     It is not simply "is this ball 1" — the tenth frame's bonus balls
     follow a clear and are struck, not spared — nor "are zero pins down",
     which is equally true after a gutter ball, where clearing is a spare.

     The cap is a courtesy, not the rule: editing ball 1 upward can still
     produce an illegal frame against a ball 2 already recorded behind it,
     which the client can't see coming. The backend re-validates the whole
     frame and 400s; the caller surfaces that message. */
  const { maxSelectable, freshRack } = useMemo(() => {
    let total = 0;
    let cleared = true; // nothing thrown yet -- a full rack is standing
    for (let i = 0; i < ballIdx && i < frame.length; i++) {
      total += frame[i];
      if (total >= FULL_RACK) { total = 0; cleared = true; }
      else cleared = false;
    }
    return { maxSelectable: cleared ? FULL_RACK : FULL_RACK - total, freshRack: cleared };
  }, [ballIdx, frame]);

  const togglePin = (pin) => {
    if (alreadyDown?.has(pin)) return; // can't knock down what's already down
    setKnocked((prev) => {
      const next = new Set(prev);
      if (next.has(pin)) next.delete(pin);
      else if (next.size < maxSelectable) next.add(pin);
      return next;
    });
  };

  /* The mask goes up with the count. The picker knows exactly which pins
     were tapped, and sending only the total is what used to leave every
     kiosk-entered ball with no per-pin detail at all -- which in turn is
     why a later ball in the same frame had nothing to grey out. A gutter
     ball sends mask 0: "nothing fell" is known, not unknown. */
  // One edit, then done — no stepping on to the next ball.
  const commit = (pins, pinMask) => {
    onCommit(frameIdx, ballIdx, pins, pinMask);
    onClose();
  };

  return {
    ballIdx,
    knocked,
    alreadyDown,
    maxSelectable,
    freshRack,
    /* "Strike" on a fresh rack, "Spare" otherwise — the shortcut for the
       most common correction there is, so nobody taps ten pins one at a
       time to record what one word describes. */
    clearLabel: freshRack ? "Strike" : "Spare",
    togglePin,
    commitSelected: () => {
      // Cap the count at what's legal, but only send a mask when the two
      // still agree -- the backend rejects a mask whose bit count doesn't
      // match the pinfall, and rightly so.
      const capped = Math.min(knocked.size, maxSelectable);
      commit(capped, capped === knocked.size ? pinsToMask(knocked) : null);
    },
    /* Everything still standing goes down. On a fresh rack that's all ten;
       otherwise it's whatever ball 1 left, which we can only name pin by
       pin when the earlier ball carried per-pin detail — without it the
       count is still exactly right, so send that alone rather than
       withholding a correction over a mask we can't build. */
    commitClear: () => {
      const mask = freshRack
        ? pinsToMask(Array.from({ length: FULL_RACK }, (_, i) => i + 1))
        : alreadyDown
          ? pinsToMask([...Array(FULL_RACK).keys()].map((i) => i + 1).filter((p) => !alreadyDown.has(p)))
          : null;
      commit(maxSelectable, mask);
    },
    commitGutter: () => commit(0, 0),
  };
}
