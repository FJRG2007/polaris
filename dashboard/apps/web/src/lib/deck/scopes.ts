/**
 * What the Stream Deck plugin may ask to be allowed to do.
 *
 * A closed list, like the CLI's: the keys a deck offers reach chat, your own
 * status, Deploy and its alarms, and Places, and nothing else. A connection that
 * asked for mail or the vault would be a credential broader than anything a key
 * on a deck can use. Each is narrowed again to what the approving account holds,
 * and the catalogue offers only what the key ends up carrying.
 *
 * Client-safe: the approval screen imports it.
 */

export const DECK_SCOPES = [
    "chat.use",
    "deploy.read",
    "deploy.manage",
    "home.read",
    "home.control",
    "home.manage"
] as const;

export type DeckScope = (typeof DECK_SCOPES)[number];

/** Whether a string is one of the scopes the plugin may ask for. */
export function isDeckScope(value: string): value is DeckScope {
    return (DECK_SCOPES as readonly string[]).includes(value);
}

/** How long a connection lasts before the deck has to be connected again. A
 *  year, for the reason the CLI's sign-in lasts one: a deck nobody uses any more
 *  stops holding a working credential on its own. */
export const DECK_TOKEN_DAYS = 365;

/** Where somebody answers a deck's request, with its code already filled in. */
export function deckApprovePath(userCode: string): string {
    return `/account/streamdeck?code=${encodeURIComponent(userCode)}`;
}
