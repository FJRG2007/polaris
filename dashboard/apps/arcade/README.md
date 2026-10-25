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

A game runs in a same-origin `<iframe>`. The game and the page that frames it
talk over `window.postMessage`, with `location.origin` as the target origin on
both sides. Each side ignores a message from another origin or another window.

The host learns the game's window from `event.source` of the first message the
game sends, or from `iframe.contentWindow`.

From the game to the host:

| `type`                  | Fields                                                               | When                                    |
| ----------------------- | -------------------------------------------------------------------- | --------------------------------------- |
| `polaris-game:hello`    |                                                                      | Once, as the page starts: asks for `setup` |
| `polaris-game:progress` | `stage`: `"data"`, `"build"` or `"compile"`; `done`: 0 to 1          | While loading, in stage order           |
| `polaris-game:ready`    |                                                                      | Once, when the first frame is on screen |
| `polaris-game:failed`   | `reason`: `"graphics"` (no WebGPU or WebGL2), `"data"`, `"error"`    | Once, instead of `ready`                |
| `polaris-game:state`    | `x`, `y`, `z`, `heading` (radians, -pi to pi), `mode`, `speed` (m/s) | Up to ten times a second, while joined  |
| `polaris-game:exit`     |                                                                      | The reader chose Exit game in the menu  |

From the host to the game:

| `type`                 | Fields                                              | Effect                                                                                   |
| ---------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `polaris-game:setup`   | `locale`, `messages` (the game's catalog), `exit`   | The game's words in the reader's language; `exit` offers Exit game in its menu. Sent on `hello` and on every change of language |
| `polaris-game:join`    | `self`: `{ id, name }`                              | Starts sending `state`                                                                   |
| `polaris-game:players` | `players`: `[{ id, name, x, y, z, heading, mode }]` | Everyone else in the session. Replaces the previous list, so a missing player is removed |
| `polaris-game:leave`   |                                                     | Stops sending `state` and removes every marker                                           |

`mode` is one of `person`, `car`, `cyclist` or `helicopter`. `id` is at most 128
characters and `name` at most 64. The game draws at most 32 other players, skips
any entry that does not fit these rules, and skips its own `id`.

`GameFrame` (`src/screens/game-frame.tsx`) draws the frame, a loading line until
the first `progress` (from then on the game's own loading screen is the one on
screen), and the failure from `failed`. On `ready` it moves the keyboard focus
into the frame, unless the reader is in a field elsewhere on the page. A game's
catalog is the namespace named by its id in `messages/<locale>/`. A call screen that runs a game inside a
call draws the app's `call-activity` slot (`{ gameId }`), then relays `join`,
`players` and `state` between that frame and the call.
