# In-Game-Me

Upload your photo and play as the character in a Subway Surfers-style endless
runner — 3 lanes, jump the barriers, slide under the bars, dodge the trains,
grab the coins. Fully client-side, no account, no uploads.

## How it works

- **Your photo → the runner's face.** Pick a photo; it is centre-cropped to a
  256px circle and drawn as the runner's head. It is stored only in this
  browser's localStorage (as a downscaled JPEG data URL) so your face is there
  next visit, and the Remove button wipes it. Nothing is ever uploaded.
- **No photo?** A default drawn face runs instead — same game.
- **Controls:** ←/→ or swipe to switch lane, ↑/Space or swipe up (or tap) to
  jump, ↓ or swipe down to slide, P to pause. On-screen buttons too.
- **Rules:** orange barrier = jump it; purple bar = slide under it; red train
  = switch lane (can't be jumped or slid); coins = 5 points each, air coins
  need a jump. Speed ramps with distance. Best score saved on-device.
- **Spawn fairness:** every obstacle row leaves at least one lane free of
  trains (checked in tests).

## Files

- `site/index.html` — the page (HUD, canvas, photo upload, controls, family footer)
- `site/app.js` — game engine; pure helpers (lanes, jump physics, collisions,
  spawn rows, scoring) are Node-testable via `module.exports`
- `site/manifest.webmanifest`, `site/sw.js` — PWA installable; service worker
  caches same-origin files only
- icons + banner drawn with PIL (amber runner on navy)

## Verified (2026-11-22, before publishing)

- `node --check` clean on app.js and sw.js; manifest parses.
- Node test harness (`/tmp/test_igm.js`, not shipped): lane clamping; jump
  apex ~1.0 height at 400 ms, lands at 800 ms, never negative; barrier /
  overhead / train / coin collision and collection rules in both directions;
  score and speed ramp; **200 random spawn rows, every one passable**.
- Every DOM id the script touches exists in index.html (12 ids); all 4
  on-screen control buttons present.
- Served locally over HTTP: all 8 files return 200.

## Still owed (after publishing, like the other sites' live checks)

- A real play-through in a phone + desktop browser: photo upload → face on
  the runner, lane switching, jump/slide timing, game-over + best score.
  This environment cannot play a canvas game end-to-end.

## Honest limits (stated on the page)

- 2D runner: the photo becomes the character's face on a drawn runner body,
  not a full 3D avatar.
- `roundRect` has a plain-rect fallback for older phone browsers.

## Publishing (needs Abubakar, same as always)

Create an empty public repo named `in-game-me` (no README), then push main +
gh-pages from here, verify live, and add its link to the other 13 sites'
footers (the family becomes 14 + Discaro).
