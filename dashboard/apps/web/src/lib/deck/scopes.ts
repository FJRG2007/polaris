/**
 * What the Stream Deck plugin may ask to be allowed to do.
 *
 * A closed list, like the CLI's: the keys a deck offers reach chat, your own
 * status, Deploy and its alarms, Places, tasks, notes, the calendar, game
 * servers and agent sessions - every tool an assistant could press a button for
 * with them - and nothing else. Mail, the vault, Drive's links and the
 * databases stay off: a key that could send mail as you, read your passwords,
 * publish a file or run SQL from a button would be a credential broader than
 * anything a deck should carry. Each is narrowed again to what the approving
 * account holds, and the catalogue offers only what the key ends up carrying.
 * A deck connected before a scope was added does not gain it: connecting again
 * asks for the new list.
 *
 * Client-safe: the approval screen imports it.
 */

export const DECK_SCOPES = [
    "chat.use",
    "deploy.read",
    "deploy.manage",
    "home.read",
    "home.control",
    "home.manage",
    "tasks.read",
    "tasks.manage",
    "notes.use",
    "calendar.use",
    "games.read",
    "games.moderate",
    "games.manage",
    "agents.read",
    "agents.manage"
] as const;

export type DeckScope = (typeof DECK_SCOPES)[number];

/** The finer MCP scopes a deck's tools ask for, each held only while the key
 *  holds the permission it stands on. A closed list too: the cameras and the
 *  databases stand on the same permissions and are nothing a key can show. */
export const DECK_FINER_SCOPES = [
    "places.read",
    "places.control",
    "places.routines",
    "calendar.read",
    "calendar.manage",
    "gameservers.read",
    "gameservers.moderate",
    "gameservers.manage"
] as const;

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
