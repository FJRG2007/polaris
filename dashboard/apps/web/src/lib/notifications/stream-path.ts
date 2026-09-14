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
import { notificationSoundEnabled } from "@/lib/notification-sound";

const STREAM_PATH = "/api/notifications/stream";

let kind: string | null = null;

/**
 * Where to follow this account's notifications, saying what is doing the
 * following and whether it would make a sound.
 *
 * The sound is here because the server skips a silenced client when it elects the
 * one to chime, and a connection only ever says this when it opens. It is read
 * fresh rather than settled with the kind: the switch moves while the page is
 * open, and a path that still claimed the old answer would have the server
 * electing a client that plays nothing.
 *
 * Every subscriber must compute the same string at the same moment, which they do
 * by all asking here and all reconnecting on `NOTIFICATION_SOUND_CHANGED`
 * together. Two spellings alive at once would be two connections, and only one of
 * them elected.
 */
export function notificationStreamPath(): string {
    kind ??= desktopBridge() ? "desktop" : "browser";
    const sound = notificationSoundEnabled() ? "on" : "off";
    return `${STREAM_PATH}?client=${kind}&sound=${sound}`;
}
