/**
 * Which Chat messages an account sees inside the game it is playing on, as the
 * settings screen offers it and as `User.messagesInGame` stores it: null for the
 * default (direct messages and small groups), true for everything, false for none.
 */

/** The largest group shown in the game by default. Past it a group is a room
 *  people talk in rather than somebody writing to you, and only the accounts
 *  that chose everything see it. */
export const SMALL_GROUP_SIZE = 10;

export const IN_GAME_CHOICES = ["auto", "all", "off"] as const;

export type InGameChoice = (typeof IN_GAME_CHOICES)[number];

export function inGameChoice(stored: boolean | null): InGameChoice {
    return stored === null ? "auto" : stored ? "all" : "off";
}

export function storedInGame(choice: InGameChoice): boolean | null {
    return choice === "auto" ? null : choice === "all";
}
