# Invisible updates - roadmap

Goal: an update to Polaris is never noticed, like Discord's. Nothing typed or
in progress is ever lost, and a reload is offered (never forced) only when the
page in use changed and the reader is busy.

## Phase 1 - reload only when nobody is using the page (in progress)

- No automatic reload while the page is in sight. A tab, the installed app or
  the phone app reloads by itself only while hidden (minimized, background,
  tray) or the moment it comes back, before anything is pressed.
- Work in progress is detected for the whole document, not per screen: an open
  dialog, a changed field, a save in flight, an unsaved editor, a call, a
  recording, a transfer or media playing all block the reload.
- Unsaved fields are kept in session storage and filled back after any reload.
  Passwords, card and one-time-code fields are never kept.
- The update card shows only when an update waits and could not be taken
  quietly; its Reload saves drafts first.

Phones freeze background tabs, so on a phone the update is taken on return,
before the first touch.

## Why an old tab fails today

Next.js salts every server action id with a key it generates at each build, so
after an update an old tab's actions answer "Server Action not found". Source:
Next 15.5 `build/webpack-config.js` (`serverReferenceHashSalt: encryptionKey`)
and `server/app-render/encryption-utils-server.js` (random key when none is set
at build time).

## Options for keeping an old tab working (decide later)

| Option | Extra cost | Security | Notes |
| --- | --- | --- | --- |
| A. Do nothing more | None | Unchanged | An old tab's action fails once; the stale-build path reloads it safely with drafts restored. Visible reload. |
| B. Fixed build-time salt | None | Loses Next's per-build id rotation; the salt is public (images build in public CI) | Old tabs keep working across any number of updates. Ids are already visible in the client bundle and every action checks its caller and validates input. |
| C. Translate old ids, previous build only | ~300 KB disk; 0 RAM in normal use (read only when an unknown id arrives) | Unchanged (rotation kept) | Middleware maps an unknown `Next-Action` id from the previous build to the current id of the same module export. A tab two updates behind falls back to A. |
| D. Translate old ids, last 5 builds | ~1.5 MB disk, 1-2 MB RAM | Unchanged | Same as C, covers tabs several updates behind. |
| E. Keep the previous version running (Vercel skew protection) | ~1 GB RAM per kept version | Unchanged | What hosted platforms do; too heavy for a home server. |

Common to B-D: the encryption key for bound action arguments comes at runtime
from a per-install secret derived from the master key, stable across builds.
Data cache invalidation (`revalidatePath`, `revalidateTag`) is keyed by path
and tag, not by action id, so none of the options affects it. Old static chunks
are content-hashed; keeping the previous build's chunks is a few MB of disk.

## Later phases

- Required updates: `/api/version` returns a `minClient`; only a client below it
  must update, and while busy it is offered, never forced.
- Offer only when the update changes the page in use (compare that route's
  chunks and actions); an unrelated update is taken silently at the next
  navigation or hidden moment.
- Installable app bundles versioned on their own.
- "Build changed" pushed over the realtime stream instead of every tab polling.

Measured on the live host (2026-11-22), worth checking alongside: `/chat/c/*`,
`/home` and `/admin/updates` were requested in bursts (669, 436 and 296 times in
149 minutes) - possibly reload loops.
