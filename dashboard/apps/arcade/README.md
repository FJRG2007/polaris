# Games

Installable app `arcade`, shown as Games, at `/games`. Each game is a page of its
own, built by `scripts/build-games.mjs` into `.assets/<game>` and served from the
app's bundle:

```
/api/app-bundles/arcade/current/assets/<game>/index.html
```

`gameFrameSrc(game)` in `src/games/registry.ts` returns that address. Nothing
from a game is loaded until a frame opens it. The page's other files are named by
their content hash and cached for good; the page itself is checked again on every
load.

## Embed contract

A game runs in an `<iframe>`. In a call it is sandboxed with `allow-scripts`
only, so its page has an opaque origin and the browser can run it out of the
dashboard's process: a same-origin frame shares the dashboard's main thread, and
building the city froze the call and the whole tab. On the game's own page the
frame stays same-origin, since an opaque origin has no storage and the game
keeps its saved place, quality and sound there. The game and the page that frames it talk over
`window.postMessage`. The game posts to `location.origin` (its URL's origin, the
dashboard's) and accepts only messages from `parent` at that origin; the host
posts with `"*"` to the frame's own window and accepts only messages whose
`event.source` is that window, from origin `"null"` (or its own). Bundle files
are served with `Access-Control-Allow-Origin: *`, since the page's module, data
and fonts are cross-origin reads from an opaque origin.

The host learns the game's window from `event.source` of the first message the
game sends, or from `iframe.contentWindow`.

From the game to the host:

| `type`                     | Fields                                                                         | When                                                  |
| -------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `polaris-game:hello`       |                                                                                | Once, as the page starts: asks for `setup`            |
| `polaris-game:progress`    | `stage`: `"data"`, `"build"` or `"compile"`; `done`: 0 to 1                    | While loading, in stage order                         |
| `polaris-game:ready`       |                                                                                | Once, when the first frame is on screen               |
| `polaris-game:failed`      | `reason`: `"graphics"` (no WebGPU or WebGL2), `"data"`, `"error"`              | Before `ready`, which takes it back                   |
| `polaris-game:state`       | `x`, `y`, `z`, `heading` (radians, -pi to pi), `mode`, `speed` (m/s), `lamps`? | Up to ten times a second, while joined                |
| `polaris-game:exit`        |                                                                                | The reader chose Exit game in the menu                |
| `polaris-game:call-action` | `action`: `"mic"`, `"leave-game"` or `"leave-call"`                            | The reader used a call control from the game's menu   |
| `polaris-game:rooms`       |                                                                                | The reader chose Play with others on the start screen |

From the host to the game:

| `type`                 | Fields                                                      | Effect                                                                                                                                                                                           |
| ---------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `polaris-game:setup`   | `locale`, `messages` (the game's catalog), `exit`, `rooms`  | The game's words in the reader's language; `exit` offers Exit game in its menu; `rooms` (`"on"`, `"denied"` or `"off"`) offers Play with others. Sent on `hello` and on every change of language |
| `polaris-game:join`    | `self`: `{ id, name }`                                      | Starts sending `state`                                                                                                                                                                           |
| `polaris-game:players` | `players`: `[{ id, name, x, y, z, heading, mode, lamps? }]` | Everyone else in the session. Replaces the previous list, so a missing player is removed                                                                                                         |
| `polaris-game:leave`   |                                                             | Stops sending `state` and removes every marker                                                                                                                                                   |
| `polaris-game:call`    | `controls` (boolean), `micOn`                               | Offers the call's microphone, Back to the call and Leave the call in the game's menu while `controls` is true. Sent once the game is ready and on every change of the microphone                 |

`mode` is one of `person`, `car`, `cyclist` or `helicopter`. `id` is at most 128
characters and `name` at most 64. The game draws at most 32 other players, skips
any entry that does not fit these rules, and skips its own `id`.

`lamps` is optional, on `state` and on each player: `{ brake, reverse, signal }`
for a car's lamps - `brake` 0 (off) to 1 (full), `reverse` true or false,
`signal` 1 (left indicator), -1 (right) or 0. It carries the indicator side, not
its blink: whoever draws the car makes it blink. The game sends it only while a
lamp is lit, and missing means every lamp is off, so a position without it is
the shape it was before lamps existed. The call drops a position whose `lamps`
does not fit; the game reads a `lamps` it cannot use as every lamp off.

`GameFrame` (`src/screens/game-frame.tsx`) draws the frame, a loading line until
the first `progress` (from then on the game's own loading screen is the one on
screen), and the failure from `failed` until a `ready` replaces it. A graphics device the browser resets after `ready` is the game's own to show: it stops drawing and puts its loading screen back with a Reload button, without a message to the host. On `ready` it
moves the keyboard focus into the frame, unless the reader is in a field, dialog,
menu or list elsewhere on the page; the first driving key does the same later. A game's
catalog is the namespace named by its id in `messages/<locale>/`. A call screen that runs a game inside a
call draws the app's `call-activity` slot (`{ gameId }`), then relays `join`,
`players` and `state` between that frame and the call.
