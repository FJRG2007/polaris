/**
 * One name per verb, for every game's players screen.
 *
 * The two screens do the same handful of things to a person - let them in, take
 * them off the list, throw them out, ban them, lift it, time them out - and each
 * had invented its own words for them. Minecraft kicked and ARK "threw off";
 * Minecraft filtered on "Online" and ARK on "Playing now"; one edited a player and
 * the other edited a name. Nothing enforced any of it, so the two drifted apart
 * every time either was touched, and an operator who runs both learned the screen
 * twice.
 *
 * So the words live here and the screens spend them. A game that says something
 * the others do not - a Steam profile, a whitelist - still writes its own label;
 * what is shared is only what is genuinely the same act.
 *
 * Pure and client-safe: both players tables are browser components.
 */

/** The cuts an operator reaches for. Anything finer is what the search box is
 *  for, and a filter nobody uses is a list nobody reads to the end of. */
export interface PlayerFilterOption {
    readonly value: string;
    readonly label: string;
}

const ALL: PlayerFilterOption = { value: "all", label: "Everyone" };
const ONLINE: PlayerFilterOption = { value: "online", label: "Online" };
const ALLOWED: PlayerFilterOption = { value: "allowed", label: "Allowed in" };
const OPERATORS: PlayerFilterOption = { value: "operators", label: "Operators" };
const BANNED: PlayerFilterOption = { value: "banned", label: "Banned" };

/**
 * The filters a game offers, in one order.
 *
 * `operators` only where the game has them: ARK's admins are a password, not a
 * list, so a filter for them would always come back empty.
 */
export function playerFilters(has: { operators?: boolean } = {}): PlayerFilterOption[] {
    return [ALL, ONLINE, ALLOWED, ...(has.operators ? [OPERATORS] : []), BANNED];
}

/** What each verb is called, wherever it is offered. The name is in the label
 *  because these are icon buttons and menu items: the label is the only thing a
 *  screen reader reads out, and "Ban" alone does not say who. */
export const playerAction = {
    add: "Add player",
    edit: (name: string) => `Edit ${name}`,
    allow: (name: string) => `Allow ${name} in`,
    remove: (name: string) => `Remove ${name} from the player list`,
    kick: (name: string) => `Kick ${name}`,
    ban: (name: string) => `Ban ${name}`,
    pardon: (name: string) => `Lift the ban on ${name}`,
    timeout: (name: string) => `Time ${name} out`,
    message: (name: string) => `Message ${name}`,
    more: (name: string) => `More for ${name}`
} as const;

/** The same verbs as they read inside the row's menu, where the name is already
 *  the heading above them and repeating it in every item is noise. */
export const playerMenuItem = {
    edit: "Edit player",
    timeout: "Time out",
    pardon: "Lift the ban",
    message: "Message them",
    history: "Joins and leaves"
} as const;

/** What a badge on a row says. Shared because the states themselves are shared,
 *  whatever each game's list is called underneath. */
export const playerStanding = {
    allowed: "allowed",
    notAllowed: "not on the list",
    /** On Polaris' list, and the server has not been told yet - it was down, or
     *  still installing. */
    waiting: "waiting",
    banned: "banned",
    operator: "operator"
} as const;

/** What a presence badge says. "Never joined" is not "offline": one is somebody
 *  who has been added and has not turned up, the other is somebody who has. */
export const playerPresence = {
    playing: "Playing",
    connecting: "Connecting",
    offline: "Offline",
    never: "Never joined"
} as const;

/** What a destructive verb asks before it happens. One wording, so the same
 *  question is not answered differently depending on which game asked it. */
export const playerConfirm = {
    kick: (name: string) => ({
        title: `Kick ${name}?`,
        description: "They are disconnected and can join again straight away."
    }),
    ban: (name: string) => ({
        title: `Ban ${name}?`,
        description: "They are disconnected and cannot rejoin until the ban is lifted."
    }),
    remove: (name: string) => ({
        title: `Remove ${name} from the player list?`,
        description:
            "The running server is told at once. While the server only lets in players on the list, they cannot join again until they are added back."
    })
} as const;
