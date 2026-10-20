/**
 * The routes whose layout draws people plainly (`PlainNames`): no plate behind a
 * row, no colour across a name.
 *
 * A scene renders a page's own component without the layouts above it, so the
 * frame (`runtime/chrome.tsx`) puts this one back for a scene standing under one
 * of these. Shared with the test, which reads every `layout.tsx` in the app and
 * fails when one gains or loses `PlainNames` and this list was not told.
 */

export const PLAIN_ROUTES = ["/admin", "/tasks"];

/** Whether a scene's path sits under a layout that draws people plainly. */
export function drawsPlainly(path) {
    return PLAIN_ROUTES.some((route) => path === route || path.startsWith(`${route}/`));
}
