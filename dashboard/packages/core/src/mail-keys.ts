/**
 * Mail's keyboard, as data somebody can change.
 *
 * The defaults are the letters every mail client has used since the first
 * webmail that had any, and they stay the defaults: somebody arriving from
 * another client has them in their fingers. What this adds is that a person can
 * move one - to a letter their keyboard layout puts somewhere reachable, or away
 * from one they keep hitting by accident.
 *
 * Three rules, and the module is mostly them:
 *
 * - **One key does one thing.** A binding that collides with another command,
 *   or with one of the keys that are not negotiable, is refused rather than
 *   stored. Two commands on `e` would mean archiving when somebody meant the
 *   other one, and which of the two wins would depend on the order of a switch.
 * - **Only single, unmodified keys.** A chord belongs to the browser or the
 *   operating system, and `useMailKeys` already stands down whenever a modifier
 *   is held - so a chord here could never fire.
 * - **Some keys are not offered.** The arrows, Enter and Escape are how every
 *   list on every system is driven, and Delete and Backspace are what somebody
 *   who has never used a mail client reaches for; they stay bound whatever the
 *   letters are moved to, and nothing may be moved onto them.
 */

import { z } from "zod";

/** Every command that has a key, rebindable or not. */
export const MAIL_KEY_COMMANDS = [
    "compose",
    "reply",
    "replyAll",
    "forward",
    "archive",
    "trash",
    "junk",
    "star",
    "important",
    "pin",
    "mute",
    "markUnread",
    "next",
    "previous",
    "open",
    "back",
    "search",
    "refresh",
    "help"
] as const;

export type MailKeyCommand = (typeof MAIL_KEY_COMMANDS)[number];

interface MailKeyDefinition {
    /** What the help sheet and the settings screen call it. */
    readonly label: string;
    /** The key it answers to until somebody moves it. Empty for a command whose
     *  only keys are the fixed ones. */
    readonly key: string;
    /** Keys it answers to whatever it is moved to, and that nothing else may
     *  take. The arrows, Enter, Escape, Delete. */
    readonly fixed: readonly string[];
}

export const MAIL_KEY_DEFINITIONS: Readonly<Record<MailKeyCommand, MailKeyDefinition>> = {
    compose: { label: "Write a message", key: "c", fixed: [] },
    reply: { label: "Reply", key: "r", fixed: [] },
    replyAll: { label: "Reply to everybody", key: "a", fixed: [] },
    forward: { label: "Forward", key: "f", fixed: [] },
    archive: { label: "Archive", key: "e", fixed: [] },
    trash: { label: "Move to the trash", key: "#", fixed: ["Delete", "Backspace"] },
    junk: { label: "Report as spam", key: "!", fixed: [] },
    star: { label: "Star or unstar", key: "s", fixed: [] },
    important: { label: "Mark important or not", key: "i", fixed: [] },
    pin: { label: "Pin to the top or unpin", key: "p", fixed: [] },
    mute: { label: "Mute or unmute", key: "m", fixed: [] },
    markUnread: { label: "Mark unread", key: "u", fixed: [] },
    next: { label: "Next conversation", key: "j", fixed: ["ArrowDown"] },
    previous: { label: "Previous conversation", key: "k", fixed: ["ArrowUp"] },
    open: { label: "Open the one you are on", key: "", fixed: ["Enter"] },
    back: { label: "Back to the list", key: "", fixed: ["Escape"] },
    search: { label: "Search", key: "/", fixed: [] },
    refresh: { label: "Check for new mail", key: "g", fixed: [] },
    help: { label: "The list of shortcuts", key: "?", fixed: [] }
};

/** The commands a person may move: every one with a key of its own. */
export const MAIL_REBINDABLE_COMMANDS: readonly MailKeyCommand[] = MAIL_KEY_COMMANDS.filter(
    (command) => MAIL_KEY_DEFINITIONS[command].key !== ""
);

/** What somebody has moved, by command. Only the ones they moved are here. */
export type MailKeymap = Readonly<Partial<Record<MailKeyCommand, string>>>;

/** Every key that is never on offer, whoever holds it. */
const FIXED_KEYS = new Set(MAIL_KEY_COMMANDS.flatMap((command) => MAIL_KEY_DEFINITIONS[command].fixed));

/**
 * Whether a key can be given to a command at all.
 *
 * One printable character that is not whitespace. A space scrolls the list and a
 * letter held with a modifier never reaches the hook, so neither could ever
 * fire; a named key (`F5`, `Tab`) belongs to the browser.
 */
export function isBindableMailKey(key: string): boolean {
    return [...key].length === 1 && !/\s/.test(key) && !FIXED_KEYS.has(key);
}

/** The key a command answers to, given what has been moved. */
export function mailKeyFor(command: MailKeyCommand, keymap: MailKeymap): string {
    return keymap[command] ?? MAIL_KEY_DEFINITIONS[command].key;
}

/**
 * The keys that collide in a keymap, and which commands want each.
 *
 * Measured over the whole resulting keyboard - the moved keys, the defaults that
 * were not moved, and the fixed keys - because a new binding colliding with an
 * untouched default is exactly as bad as two moved keys colliding.
 */
export function mailKeyConflicts(keymap: MailKeymap): Map<string, MailKeyCommand[]> {
    const holders = new Map<string, MailKeyCommand[]>();
    for (const command of MAIL_KEY_COMMANDS) {
        const keys = [mailKeyFor(command, keymap), ...MAIL_KEY_DEFINITIONS[command].fixed];
        for (const key of keys) {
            if (!key) continue;
            holders.set(key, [...(holders.get(key) ?? []), command]);
        }
    }
    return new Map([...holders].filter(([, commands]) => commands.length > 1));
}

/**
 * Which command a key press means, for the hook.
 *
 * Built once per keymap rather than per press. A keymap that somehow still has a
 * collision in it - a row hand-edited in the database - resolves the key to the
 * first command in the fixed order rather than to whichever the switch reached,
 * so the answer at least never changes between two presses.
 */
export function resolveMailKeymap(keymap: MailKeymap): ReadonlyMap<string, MailKeyCommand> {
    const out = new Map<string, MailKeyCommand>();
    for (const command of MAIL_KEY_COMMANDS) {
        const keys = [mailKeyFor(command, keymap), ...MAIL_KEY_DEFINITIONS[command].fixed];
        for (const key of keys) {
            if (key && !out.has(key)) out.set(key, command);
        }
    }
    return out;
}

/**
 * What was stored, cleaned.
 *
 * The forgiving half, for reading the preference column: an unknown command, a
 * key that cannot be bound, a key moved back onto its own default - all dropped
 * rather than refused, and if what is left still collides, the whole map goes,
 * because a partial repair of a collision is a guess about which of two
 * commands somebody wanted on that key.
 */
export function cleanMailKeymap(raw: unknown): MailKeymap {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const kept: Partial<Record<MailKeyCommand, string>> = {};
    for (const command of MAIL_REBINDABLE_COMMANDS) {
        const key = (raw as Record<string, unknown>)[command];
        if (typeof key !== "string" || !isBindableMailKey(key)) continue;
        if (key === MAIL_KEY_DEFINITIONS[command].key) continue;
        kept[command] = key;
    }
    return mailKeyConflicts(kept).size > 0 ? {} : kept;
}

/**
 * What the shortcuts screen is allowed to send.
 *
 * The strict half: every entry a command that can be moved, every key one that
 * can be bound, and no two commands on one key - with the refusal naming both,
 * so the screen can say which binding is in the way.
 */
export const mailKeymapSchema = z
    .record(z.string(), z.string())
    .superRefine((value, context) => {
        for (const [command, key] of Object.entries(value)) {
            if (!(MAIL_REBINDABLE_COMMANDS as readonly string[]).includes(command)) {
                context.addIssue({ code: "custom", message: "That is not a shortcut.", path: [command] });
                continue;
            }
            if (!isBindableMailKey(key)) {
                context.addIssue({
                    code: "custom",
                    message: "Use one key with nothing held down, other than Enter, Escape, the arrows or Delete.",
                    path: [command]
                });
            }
        }
        for (const [key, commands] of mailKeyConflicts(value as MailKeymap)) {
            const [first, second] = commands;
            if (!first || !second) continue;
            context.addIssue({
                code: "custom",
                message: `${key} would do two things: ${MAIL_KEY_DEFINITIONS[first].label.toLowerCase()} and ${MAIL_KEY_DEFINITIONS[second].label.toLowerCase()}.`,
                path: [second]
            });
        }
    })
    .transform((value) => cleanMailKeymap(value));

/** What to write for a key on screen: the arrows and the named keys as words. */
export function mailKeyLabel(key: string): string {
    switch (key) {
        case "ArrowDown":
            return "Down";
        case "ArrowUp":
            return "Up";
        case "Escape":
            return "Esc";
        default:
            return key;
    }
}
