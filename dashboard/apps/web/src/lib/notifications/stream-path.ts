/**
 * The one address every part of Polaris follows the notification stream on.
 *
 * It says which kind of Polaris is asking, because the server elects one
 * connection of an account to raise what belongs to the device - the chime above
 * all - and prefers the desktop app. See `live-clients`.
 *
 * It lives here rather than being written out wherever a screen needs it, because
 * `subscribeSharedStream` names its lock and its channel after the path it was
 * given: two spellings of this stream are two connections to it, on a device that
 * should hold one. That costs a second poll of the feed, and worse - only one of
 * the two is elected, and the one listening for the chime is not necessarily it.
 * A device that had two spellings went quiet.
 *
 * Settled once for the page. Every subscriber has to agree, and a question asked
 * again later is a question that could be answered differently.
 */

import { desktopBridge } from "@/lib/desktop-bridge";

const STREAM_PATH = "/api/notifications/stream";

let settled: string | null = null;

/** Where to follow this account's notifications, saying what is doing the
 *  following. The same string for every caller on this page. */
export function notificationStreamPath(): string {
    settled ??= `${STREAM_PATH}?client=${desktopBridge() ? "desktop" : "browser"}`;
    return settled;
}
