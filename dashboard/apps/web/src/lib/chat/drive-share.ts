/**
 * What happens when somebody sends a file they already have in Drive.
 *
 * Two honest answers, and the operator picks, because the cost sits in different
 * places.
 *
 * **Copied** is what Polaris has always done: the bytes are read out of the Drive
 * and written into the conversation's own store, and from then on the message
 * carries its own copy. Nothing can change under it and nothing can take it away,
 * and the instance pays for a second copy of every file anybody shares - twice
 * over for a file shared into three conversations.
 *
 * **Linked** writes no bytes at all. The message points at the file where it
 * already lives, which is free, instant whatever the file weighs, and the only
 * answer that works at all for the sizes people actually keep in a Drive: the
 * per-file ceiling is about what the server stores, and a link stores nothing.
 * What it costs is the promises a copy makes. The owner can edit the file, and
 * everyone in the conversation then sees the new one under the old sentence. The
 * owner can delete it, and the message is left pointing at nothing. Neither is a
 * fault to be fixed - it is what sharing a place rather than a thing means - so
 * the conversation says which kind it is looking at.
 *
 * Copied is the default, and deliberately: it is what every existing install
 * already does, and an instance that has never opened this screen must not have
 * the guarantees of its old messages quietly changed.
 */

import { getSetting, setSetting } from "@/lib/setting-store";

/** How a Drive file reaches a conversation. */
export type DriveShare = "copy" | "link";

/** Stored only when an operator has asked for links: the absence of a row is the
 *  default, and the default is a copy. */
const KEY = "chat.driveShare";

export async function driveShare(): Promise<DriveShare> {
    return (await getSetting(KEY)) === "link" ? "link" : "copy";
}

export async function setDriveShare(how: DriveShare): Promise<void> {
    await setSetting(KEY, how === "link" ? "link" : null);
}

/** Whether a shape is one of the two answers, for a value arriving off a form. */
export function isDriveShare(value: unknown): value is DriveShare {
    return value === "copy" || value === "link";
}
