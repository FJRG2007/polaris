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

/**
 * What the app's own pages are given, which is only ever one thing: the camera
 * to the settings window, to read a QR of hosts off another device. Video and
 * nothing else - never the microphone - and no other page of ours.
 */
export function allowLocalPermission(
    permission: string,
    kind: string | null,
    mediaTypes: readonly string[] | undefined
): boolean {
    if (permission !== "media" || kind !== "connect") return false;
    return mediaTypes === undefined || (mediaTypes.length > 0 && mediaTypes.every((type) => type === "video"));
}

export function allowPermission(permission: string, requestingUrl: string, serverOrigin: string | null): boolean {
    if (!serverOrigin || !GRANTED.has(permission)) return false;
    try {
        return new URL(requestingUrl).origin === serverOrigin;
    } catch {
        return false;
    }
}
