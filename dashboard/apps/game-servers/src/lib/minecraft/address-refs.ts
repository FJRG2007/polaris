/**
 * Opaque stand-ins for the network addresses players connect from.
 *
 * The people running a game server decide who may join from where, but where a
 * person connects from is that person's, not the server's. So unless an
 * administrator lets them see addresses, every address on the players screen is
 * shown as a reference instead: the same address on the same server is always
 * the same reference (two players on one line read as one reference), a
 * different server gives a different one (references cannot be joined across
 * servers), and the address cannot be read back out of it.
 *
 * Anything the screen does with an address - allow it, take it off a player -
 * sends the reference back, and the server turns it into the address by
 * recomputing the references of the addresses it already holds for that server.
 * A reference that matches none of them is refused rather than guessed at.
 *
 * The key lives in the setting store, created on first use, so it needs no
 * environment value and exists on every install from the first time it is read.
 */

import { host } from "@polaris/app-host";
import { ADDRESS_REF_PREFIX, isAddressRef } from "./address-label";
import { createHmac, randomBytes } from "node:crypto";

const { getSetting, setSetting } = host.settingStore;

const KEY_SETTING = "games.address-ref-key";

export { ADDRESS_REF_PREFIX, isAddressRef };

/** The reference `address` reads as on the server `scope`, under `key`. */
export function addressRef(key: string, scope: string, address: string): string {
    const digest = createHmac("sha256", key)
        .update(`${scope}\n${address.trim().toLowerCase()}`)
        .digest("hex");
    return `${ADDRESS_REF_PREFIX}${digest.slice(0, 10)}`;
}

/** The address among `candidates` that `ref` stands for on `scope`, or null. */
export function resolveAddressRef(
    key: string,
    scope: string,
    ref: string,
    candidates: Iterable<string>
): string | null {
    if (!isAddressRef(ref)) return null;
    for (const candidate of candidates) {
        if (addressRef(key, scope, candidate) === ref) return candidate.trim().toLowerCase();
    }
    return null;
}

/** The instance's reference key, created the first time it is needed. */
export async function addressRefKey(): Promise<string> {
    const stored = await getSetting(KEY_SETTING).catch(() => null);
    if (stored && stored.length >= 32) return stored;
    const created = randomBytes(32).toString("hex");
    await setSetting(KEY_SETTING, created);
    // Two first reads at once would each write a key; the one that stuck is
    // the one every later read gets, so return that rather than our own.
    return (await getSetting(KEY_SETTING).catch(() => null)) ?? created;
}
