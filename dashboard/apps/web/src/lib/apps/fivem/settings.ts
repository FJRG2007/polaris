/**
 * The rules a FiveM server is run under, and where each one is written.
 *
 * All of them live in `server.cfg` and all of them are read at boot, so nothing
 * here changes a server that is already up - the screen says so rather than
 * pretending otherwise, exactly as the ARK one does. What is different is that
 * these are console variables rather than launch options: the same value can be
 * spelled three ways and which spelling it wants is the game's business, so each
 * setting carries its own.
 *
 * The catalogue is deliberately the settings a server owner actually reaches for.
 * FXServer has hundreds of variables, most of which only mean something to a
 * resource that is not installed; a list of those would be a screen of switches
 * that change nothing, which is worse than not offering them.
 *
 * Pure: the rules screen validates against exactly what the action re-checks with,
 * and the file this describes is read and written by `cfg.ts`.
 */

import type { CfgKey, CfgPrefix } from "@/lib/apps/fivem/cfg";

export type FivemSettingType = "boolean" | "number" | "text" | "choice";

export interface FivemSettingChoice {
    readonly value: string;
    readonly label: string;
}

export interface FivemSetting extends CfgKey {
    readonly key: string;
    readonly prefix: CfgPrefix;
    readonly label: string;
    /** One line saying what it does, in the terms somebody changing it thinks in. */
    readonly hint: string;
    readonly type: FivemSettingType;
    /** The heading it sits under. */
    readonly group: string;
    /** What the server does when the file does not set it, so a row can say what
     *  an empty box means. */
    readonly fallback: string;
    /** For a switch: what is written for each state. Null removes the line, which
     *  for a handful of these is the only way to say "the default". */
    readonly onValue?: string | null;
    readonly offValue?: string | null;
    readonly min?: number;
    readonly max?: number;
    readonly choices?: readonly FivemSettingChoice[];
    /** Whether the value is a credential, so the screen never prints one back. */
    readonly secret?: boolean;
    /** How long a text value may be, since every one of these ends up on a line
     *  the server parses. */
    readonly maxLength?: number;
}

const SERVER = "Server";
const GAMEPLAY = "Gameplay";
const PLAYERS = "Players";
const LISTING = "Server browser";

export const FIVEM_SETTINGS: readonly FivemSetting[] = [
    {
        key: "sv_hostname",
        prefix: "",
        label: "Server name",
        hint: "What players see in the server browser and on the connecting screen.",
        type: "text",
        group: SERVER,
        fallback: "FXServer",
        maxLength: 255
    },
    {
        key: "sv_maxclients",
        prefix: "",
        label: "Player slots",
        hint: "How many people fit. Above 32 needs OneSync on.",
        type: "number",
        group: SERVER,
        fallback: "30",
        min: 1,
        max: 2048
    },
    {
        key: "onesync",
        prefix: "",
        label: "OneSync",
        hint: "The state synchronisation everything above 32 slots and most roleplay resources need.",
        type: "choice",
        group: GAMEPLAY,
        fallback: "off",
        choices: [
            { value: "on", label: "On" },
            { value: "legacy", label: "Legacy" },
            { value: "off", label: "Off" }
        ]
    },
    {
        key: "onesync_population",
        prefix: "set",
        label: "Ambient traffic and pedestrians",
        hint: "Off empties the streets, which is what a roleplay server usually wants.",
        type: "boolean",
        group: GAMEPLAY,
        fallback: "on"
    },
    {
        key: "sv_enforceGameBuild",
        prefix: "",
        label: "Game build",
        hint: "Pins every player to one GTA update, for resources that need a particular one. Blank is the newest.",
        type: "number",
        group: GAMEPLAY,
        fallback: "the newest",
        min: 0,
        max: 100000
    },
    {
        key: "sv_scriptHookAllowed",
        prefix: "",
        label: "Allow ScriptHook mods",
        hint: "On lets players run single-player mod menus. It is how most cheating gets in.",
        type: "boolean",
        group: GAMEPLAY,
        fallback: "off",
        onValue: "1",
        offValue: "0"
    },
    {
        key: "sv_pureLevel",
        prefix: "",
        label: "File checking",
        hint: "Refuses players whose game files were changed. Level 2 also checks the audio and text.",
        type: "choice",
        group: GAMEPLAY,
        fallback: "off",
        choices: [
            { value: "0", label: "Off" },
            { value: "1", label: "Game files must match" },
            { value: "2", label: "Game files, audio and text must match" }
        ]
    },
    {
        key: "sv_endpointprivacy",
        prefix: "",
        label: "Hide player addresses",
        hint: "Keeps connecting players' addresses out of the log and the public player list.",
        type: "boolean",
        group: PLAYERS,
        fallback: "off"
    },
    {
        key: "sv_authMaxVariance",
        prefix: "",
        label: "Account checks",
        hint: "Lower refuses accounts that look freshly made. 1 is the strictest.",
        type: "number",
        group: PLAYERS,
        fallback: "1",
        min: 1,
        max: 5
    },
    {
        key: "sv_authMinTrust",
        prefix: "",
        label: "Account trust",
        hint: "Higher refuses accounts with a poor standing. 5 is the strictest.",
        type: "number",
        group: PLAYERS,
        fallback: "1",
        min: 1,
        max: 5
    },
    {
        key: "steam_webApiKey",
        prefix: "set",
        label: "Steam Web API key",
        hint: "Only needed if you want players' Steam ids. Get one from Steam's developer page.",
        type: "text",
        group: PLAYERS,
        fallback: "none",
        secret: true,
        maxLength: 64
    },
    {
        key: "sv_master1",
        prefix: "",
        label: "List in the public server browser",
        hint: "Off keeps the server off the public list. People who know the address can still join.",
        type: "boolean",
        group: LISTING,
        fallback: "on",
        // On is the absence of the line: setting it to anything at all is how a
        // server is taken off the list, and there is no value that means "listed".
        onValue: null,
        offValue: ""
    },
    {
        key: "sv_projectName",
        prefix: "sets",
        label: "Project name",
        hint: "Shown above the server in the browser, next to its description.",
        type: "text",
        group: LISTING,
        fallback: "none",
        maxLength: 64
    },
    {
        key: "sv_projectDesc",
        prefix: "sets",
        label: "Description",
        hint: "One line about the server, in the browser.",
        type: "text",
        group: LISTING,
        fallback: "none",
        maxLength: 128
    },
    {
        key: "locale",
        prefix: "sets",
        label: "Language",
        hint: "The tag players filter the browser by, like en-US or es-ES.",
        type: "text",
        group: LISTING,
        fallback: "none",
        maxLength: 16
    },
    {
        key: "tags",
        prefix: "sets",
        label: "Tags",
        hint: "Comma separated, for the browser's filters: roleplay, drift, economy.",
        type: "text",
        group: LISTING,
        fallback: "none",
        maxLength: 128
    }
];

/** The groups in the order the screen shows them. */
export const FIVEM_SETTING_GROUPS: readonly string[] = [SERVER, GAMEPLAY, PLAYERS, LISTING];

export function findSetting(key: string): FivemSetting | undefined {
    return FIVEM_SETTINGS.find((setting) => setting.key.toLowerCase() === key.toLowerCase());
}

/** What is written for a switch in a given state. */
export function switchValue(setting: FivemSetting, on: boolean): string | null {
    if (on) return setting.onValue === undefined ? "true" : setting.onValue;
    return setting.offValue === undefined ? "false" : setting.offValue;
}

/**
 * Whether a switch reads as on, given what the file holds.
 *
 * Null is the file not setting it, which is the game's own default - and for a
 * couple of these the default IS the on state, so this cannot simply answer false.
 */
export function switchIsOn(setting: FivemSetting, raw: string | null): boolean {
    if (raw === null) return setting.fallback === "on";
    const on = switchValue(setting, true);
    const off = switchValue(setting, false);
    if (on !== null && raw === on) return true;
    if (off !== null && raw === off) return false;
    // A file somebody wrote by hand may spell it another way, and every spelling
    // the console accepts for true is one of these.
    return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/** Whether a value is one this setting will accept, checked the same way on both
 *  sides. The message is what the screen shows, and null is a value that is fine. */
export function settingError(setting: FivemSetting, value: string): string | null {
    if (value.includes("\"")) return "A double quote is not something the server config can hold";
    if (/[\r\n]/.test(value)) return "That has to be one line";
    switch (setting.type) {
        case "number": {
            if (value.trim().length === 0) return null;
            const number = Number(value);
            if (!Number.isInteger(number)) return "That has to be a whole number";
            if (setting.min !== undefined && number < setting.min) return `The lowest is ${setting.min}`;
            if (setting.max !== undefined && number > setting.max) return `The highest is ${setting.max}`;
            return null;
        }
        case "choice":
            return value.trim().length === 0 || setting.choices?.some((choice) => choice.value === value)
                ? null
                : "That is not one of the options";
        case "text":
            return setting.maxLength !== undefined && value.length > setting.maxLength
                ? `That is longer than ${setting.maxLength} characters`
                : null;
        default:
            return null;
    }
}
