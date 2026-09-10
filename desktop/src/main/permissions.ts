/**
 * Which browser permissions the Polaris window is given. Pure, for the tests.
 *
 * Deny by default, and only ever for the configured Polaris - never for a page
 * in a frame it embeds, or for anything else that ends up in a window:
 *
 * - `notifications` - the dashboard's own notices (calls, messages, mail).
 * - `clipboard-read`, `clipboard-sanitized-write` - copy and paste buttons.
 * - `media` - the microphone and camera, which a call in Chat cannot work
 *   without; the operating system still asks the person the first time.
 * - `fullscreen` - a video or a call's stage, full screen.
 * - `display-capture` - sharing a screen or a window in a call, or recording a
 *   clip of one; what is shared is picked by the person (`screen-share`).
 */

const GRANTED = new Set([
    "notifications",
    "clipboard-read",
    "clipboard-sanitized-write",
    "media",
    "fullscreen",
    "display-capture"
]);

export function allowPermission(
    permission: string,
    requestingUrl: string,
    serverOrigin: string | null
): boolean {
    if (!serverOrigin || !GRANTED.has(permission)) return false;
    try {
        return new URL(requestingUrl).origin === serverOrigin;
    } catch {
        return false;
    }
}
