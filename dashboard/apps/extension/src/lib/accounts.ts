/**
 * The accounts this browser has been let into, and which of them is in front.
 *
 * Nobody has one account. A person has their own and the one they are paid for,
 * and until now this extension could hold exactly one at a time: signing into the
 * second meant signing out of the first, typing an address again, and approving
 * again. The list here is what makes the other ones somewhere to go back to.
 *
 * The shape of it is a swap rather than a rewrite. Everything in the worker reads
 * the active account from where it has always read it - one refresh token, one set
 * of wrapped keys, one address - so making another account active means moving its
 * record into those same places and setting aside what was there. The alternative,
 * keying every stored value by account, would have rewritten every read path in
 * the worker and left every existing install with its session in the old spelling.
 *
 * Nothing here touches storage or the network, which is the point: what is parked
 * and what is in front is a decision, and a decision is worth being able to assert
 * without a browser.
 */

/** The keys a vault hands over on the way in, kept so unlocking needs no network. */
export interface WrappedKeys {
    readonly key: string;
    readonly privateKey: string | null;
    readonly kdf: unknown;
}

/**
 * One account, with everything needed to make it the active one again.
 *
 * It carries a refresh token, so wherever this is stored is storage for a
 * credential - session rather than disk, the same rule the active account's own
 * token follows. The vault key is deliberately absent: that never goes anywhere
 * but memory, so a parked account's key is held beside the worker's own rather
 * than written down here.
 */
export interface ParkedAccount {
    readonly id: string;
    readonly origin: string;
    readonly email: string | null;
    readonly name: string | null;
    readonly refresh: string;
    readonly wrapped: WrappedKeys | null;
    readonly accountKey: string | null;
}

/** As much of an account as a row needs in order to name it. */
export interface AccountFace {
    readonly name: string | null;
    readonly email: string | null;
    readonly origin: string;
}

/**
 * What tells one account from another.
 *
 * The address and the email together, because neither is enough on its own: two
 * people on the same Polaris are two accounts, and the same person on two servers
 * is also two. Normalized, so an address typed with a capital letter is not a
 * second account for the same person.
 *
 * The newline is the separator on purpose - it cannot occur in either half, so no
 * pair of values can be spelled two ways or collide with another pair.
 *
 * An account whose email has not arrived yet - a session opened by approval, before
 * the first sync carries the profile down - identifies as the address alone. Two of
 * those on one server would read as the same account, which is a real limit rather
 * than a hidden one: the second would replace the first in the list instead of
 * appearing beside it. It lasts until the sync that names them, which is seconds.
 */
export function accountId(origin: string, email: string | null): string {
    return `${origin.trim().toLowerCase()}\n${(email ?? "").trim().toLowerCase()}`;
}

/**
 * Set an account aside, replacing whatever was parked under the same identity.
 *
 * Replacing rather than appending, because parking the account that is already in
 * the list is the ordinary case - switching away from one and back to it - and an
 * append would leave two rows for one account, one of them holding a spent token.
 */
export function parkAccount(
    parked: readonly ParkedAccount[],
    account: ParkedAccount
): ParkedAccount[] {
    return [...parked.filter((one) => one.id !== account.id), account];
}

/** Lift one account out of the list, and what is left without it. */
export function takeAccount(
    parked: readonly ParkedAccount[],
    id: string
): { taken: ParkedAccount; rest: ParkedAccount[] } | null {
    const taken = parked.find((one) => one.id === id);
    if (!taken) return null;
    return { taken, rest: parked.filter((one) => one.id !== id) };
}

/**
 * The host of an address, for a row that has nothing better to show.
 *
 * A stored address that will not parse is shown as it stands rather than hidden:
 * it is still the only thing distinguishing that row from another, and a blank row
 * somebody cannot identify is worse than an ugly one.
 */
export function accountHost(origin: string): string {
    try {
        return new URL(origin).host;
    } catch {
        return origin;
    }
}

/**
 * What to call an account on screen.
 *
 * The name if Polaris gave one, the email if not, and the address if neither -
 * which happens on a server too old to mint the account credential, and on a
 * session opened by approval before the first sync lands. Every one of those is
 * still a row somebody has to be able to pick out of a list, so none of them is
 * allowed to come back empty.
 */
export function describeAccount(who: AccountFace): string {
    return who.name?.trim() || who.email?.trim() || accountHost(who.origin);
}
