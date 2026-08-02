# Route skeletons

A navigation between dashboard screens shows `app/(app)/loading.tsx` until the
new page resolves. What it draws is a **recording of the screen being opened** -
the position of every block that screen really renders - rather than a generic
stack of bars that fits nothing. The recordings live in
`apps/web/src/bones/*.bones.json` and are made with
[boneyard-js](https://boneyard.vercel.app), which walks the running app and reads
the layout the browser already computed.

Three pieces:

| Piece | Where |
| --- | --- |
| Draws the recording | `BoneSkeleton` in `packages/ui/src/components/bone-skeleton.tsx` |
| Marks the region to record, and shows it on a navigation | `apps/web/src/components/route-skeleton.tsx` |
| The recordings, and the list of screens that have one | `apps/web/src/bones/` |

A screen with no recording falls back to a generic heading and a few rows, so
adding a route never makes it worse than it was - it just does not get the
tailored shape until someone records it.

## Recording

`boneyard-js` is a devDependency and drives a browser to read the DOM, so the
capture needs the app running and signed in. It attaches to a Chrome you are
already logged into over the DevTools protocol, which is why there is no browser
download and no session to fake.

1. Build and serve the app (the dev server does not run on every machine):

   ```sh
   cd dashboard/apps/web
   set -a && . .env.local && set +a && export NODE_ENV=production
   npm run build && npm run start
   ```

2. Start Chrome with a debugging port and sign in to `http://localhost:3000`:

   ```sh
   chrome --remote-debugging-port=9222 --user-data-dir=/tmp/polaris-capture
   ```

   The flag is what opens the port; the toggle in `chrome://inspect` does not.

3. Record:

   ```sh
   cd dashboard/apps/web
   npx boneyard-js build --cdp 9222 http://localhost:3000
   ```

   It walks the routes under `src/app`, skipping dynamic segments, and writes one
   `<name>.bones.json` per screen at each width in `boneyard.config.json`. Its own
   `registry.ts` output is not used - `src/bones/index.ts` is the list Polaris
   reads, so add a line there for any new screen.

## Widths

`boneyard.config.json` records at 375, 768 and 1280. Those are the viewport
widths, and `BoneSkeleton` picks between them with the matching Tailwind media
queries (`md` and `xl`) rather than by measuring, so the first painted frame is
already the right one. Changing the list means changing the `VISIBILITY` map in
`bone-skeleton.tsx` with it.

## In-view skeletons

This covers navigation only. A region that loads its own data after the page has
painted keeps its own placeholder next to the content it replaces - see
`ListingSkeleton` in `drive/files-view.tsx` for the shape to follow: mirror the
real columns and row heights, and follow the view mode when the content has one.
