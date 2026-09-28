/**
 * Whether the people who run a game server see where other accounts sign in from.
 *
 * Looking somebody up to add them to a server's player list offers the addresses
 * their Polaris sessions arrive from, so the rule can be written without asking
 * them. That is somebody else's network location handed to whoever manages the
 * server, so an administrator decides it for the whole instance. Administrators
 * themselves always see them: they already read every session's address.
 *
 * On unless an administrator turns it off, because that is how the lookup has
 * always behaved and turning it off quietly would break the step people use.
 */

import { getSetting, setSetting } from "@/lib/setting-store";

const KEY = "games.share-player-addresses";

/** Whether managers of a game server are shown other accounts' addresses. */
export async function playerAddressesShared(): Promise<boolean> {
    return (await getSetting(KEY)) !== "false";
}

export async function setPlayerAddressesShared(shared: boolean): Promise<void> {
    await setSetting(KEY, shared ? "true" : "false");
}
