/**
 * The Polaris servers this browser knows, and which one is in front.
 *
 * A person with a Polaris at home and one at work had exactly one address in
 * this extension, typed on the first run, and no way anywhere to see it, change
 * it or add the other one. The accounts switcher could already hold accounts on
 * two servers - each parked account carries its own address - but the only way
 * to reach a second server was to sign out until the address was forgotten.
 *
 * The list is what makes a server something to go back to. It holds addresses
 * and the names somebody gave them, nothing else: every credential stays where
 * it already lived, with the account it belongs to (`lib/accounts`), and
 * switching servers is switching to an account on that server - or, where none
 * is signed in yet, setting the one in front aside and landing on that server's
 * "connect this browser".
 *
 * Nothing here touches storage or the network, so what the list says can be
 * asserted without a browser.
 */

import { accountHost } from "@/lib/accounts";

/** One server as it is stored: an address, and what somebody called it. */
export interface SavedServer {
    readonly origin: string;
    /** Null until somebody renames it; the host is shown until then. */
    readonly name: string | null;
}

/** One server as the popup draws it. No credential of any kind crosses. */
export interface ServerRef {
    readonly origin: string;
    readonly name: string | null;
    readonly host: string;
    /** Whether it is the server everything else in the popup is about. */
    readonly active: boolean;
    /** How many accounts are signed in on it, in front or set aside. */
    readonly accounts: number;
}

/** The longest name a server may be given - a row in a 360-pixel popup. */
export const SERVER_NAME_MAX = 40;

/**
 * A typed name, in the form it is stored and compared in: surrounding space
 * trimmed and inner runs of it collapsed, so "  Home   lab " and "Home lab" are
 * one name. Empty becomes null, which means "show the host".
 */
export function normalizeServerName(typed: string): string | null {
    const name = typed.replace(/\s+/g, " ").trim();
    return name === "" ? null : name;
}

/** Why a name cannot be used, or null when it can. Run on the normalized form. */
export function serverNameProblem(name: string | null): "tooLong" | null {
    return name !== null && name.length > SERVER_NAME_MAX ? "tooLong" : null;
}

/** Add a server, keeping the list's order and never listing one twice. */
export function withServer(saved: readonly SavedServer[], origin: string): SavedServer[] {
    if (saved.some((one) => one.origin === origin)) return [...saved];
    return [...saved, { origin, name: null }];
}

/** Give a server a name, or take it away with null. Unknown servers are left out. */
export function renameServer(
    saved: readonly SavedServer[],
    origin: string,
    name: string | null
): SavedServer[] {
    return saved.map((one) => (one.origin === origin ? { ...one, name } : one));
}

/** The list without one server. */
export function withoutServer(saved: readonly SavedServer[], origin: string): SavedServer[] {
    return saved.filter((one) => one.origin !== origin);
}

/**
 * Every server to show, in the order they were added.
 *
 * The saved list first, then any address an account still carries that the list
 * does not - which is every install from before the list existed, whose one
 * server and parked accounts are all it has. They are shown rather than
 * migrated, so an old install needs nothing written to look right.
 */
export function listServers(
    saved: readonly SavedServer[],
    active: string | null,
    signedIn: readonly string[]
): ServerRef[] {
    const order = [...saved];
    for (const origin of [...signedIn, ...(active ? [active] : [])]) {
        if (!order.some((one) => one.origin === origin)) order.push({ origin, name: null });
    }
    return order.map((one) => ({
        origin: one.origin,
        name: one.name,
        host: accountHost(one.origin),
        active: one.origin === active,
        accounts: signedIn.filter((origin) => origin === one.origin).length
    }));
}

/**
 * The account to put in front when switching to a server: the one on it that
 * was set aside most recently, which is the last of them in the parked list.
 * Null when nobody is signed in there yet.
 */
export function accountOn<T extends { readonly origin: string }>(
    parked: readonly T[],
    origin: string
): T | null {
    for (let i = parked.length - 1; i >= 0; i--) {
        if (parked[i]!.origin === origin) return parked[i]!;
    }
    return null;
}

/** What to call a server on screen: its name, or its host until it has one. */
export function describeServer(server: Pick<ServerRef, "name" | "host">): string {
    return server.name ?? server.host;
}
