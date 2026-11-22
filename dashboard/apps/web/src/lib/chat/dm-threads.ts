/**
 * The administrator's switch for threads in direct messages and groups.
 *
 * Off by default: an unset key reads as off, so every install has a working
 * answer without anything written to it. The decision itself is
 * `mayStartThread` (`./thread-rules`).
 */

import { getSetting, setSetting } from "@/lib/setting-store";

const KEY = "chat.directThreads";

export async function directThreadsAllowed(): Promise<boolean> {
    return (await getSetting(KEY)) === "on";
}

export async function setDirectThreadsAllowed(allowed: boolean): Promise<void> {
    await setSetting(KEY, allowed ? "on" : null);
}
