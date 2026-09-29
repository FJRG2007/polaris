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

import type { Translator } from "@polaris/core";
import { gameCatalogs, type GameKey } from "../../../messages";
import type { CfgKey, CfgPrefix } from "./cfg";

export type FivemSettingType = "boolean" | "number" | "text" | "choice";

export interface FivemSettingChoice {
    readonly value: string;
    /** Its name, as a key into the `fivem` catalog. */
    readonly label: GameKey<"fivem">;
}

export interface FivemSetting extends CfgKey {
    readonly key: string;
    readonly prefix: CfgPrefix;
    /** Its name, as a key into the `fivem` catalog. */
    readonly label: GameKey<"fivem">;
    /** One line saying what it does, in the terms somebody changing it thinks in. */
    /** What it does, as a key into the `fivem` catalog, or empty for none. */
    readonly hint: GameKey<"fivem"> | "";
    readonly type: FivemSettingType;
    /** The heading it sits under. */
    /** The heading it sits under, as a key into the `fivem` catalog. */
    readonly group: GameKey<"fivem">;
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

const SERVER = "settingGroups.server";
const GAMEPLAY = "settingGroups.gameplay";
const PLAYERS = "settingGroups.players";
const LISTING = "settingGroups.listing";

export const FIVEM_SETTINGS: readonly FivemSetting[] = [
    {
        key: "sv_hostname",
        prefix: "",
        label: "settings.sv_hostname.label",
        hint: "settings.sv_hostname.hint",
        type: "text",
        group: SERVER,
        fallback: "FXServer",
        maxLength: 255
    },
    {
        key: "sv_maxclients",
        prefix: "",
        label: "settings.sv_maxclients.label",
        hint: "settings.sv_maxclients.hint",
        type: "number",
        group: SERVER,
        fallback: "30",
        min: 1,
        max: 2048
    },
    {
        key: "onesync",
        prefix: "",
        label: "settings.onesync.label",
        hint: "settings.onesync.hint",
        type: "choice",
        group: GAMEPLAY,
        fallback: "off",
        choices: [
            { value: "on", label: "settings.onesync.choices.on" },
            { value: "legacy", label: "settings.onesync.choices.legacy" },
            { value: "off", label: "settings.onesync.choices.off" }
        ]
    },
    {
        key: "onesync_population",
        prefix: "set",
        label: "settings.onesync_population.label",
        hint: "settings.onesync_population.hint",
        type: "boolean",
        group: GAMEPLAY,
        fallback: "on"
    },
    {
        key: "sv_enforceGameBuild",
        prefix: "",
        label: "settings.sv_enforceGameBuild.label",
        hint: "settings.sv_enforceGameBuild.hint",
        type: "number",
        group: GAMEPLAY,
        fallback: "the newest",
        min: 0,
        max: 100000
    },
    {
        key: "sv_scriptHookAllowed",
        prefix: "",
        label: "settings.sv_scriptHookAllowed.label",
        hint: "settings.sv_scriptHookAllowed.hint",
        type: "boolean",
        group: GAMEPLAY,
        fallback: "off",
        onValue: "1",
        offValue: "0"
    },
    {
        key: "sv_pureLevel",
        prefix: "",
        label: "settings.sv_pureLevel.label",
        hint: "settings.sv_pureLevel.hint",
        type: "choice",
        group: GAMEPLAY,
        fallback: "off",
        choices: [
            { value: "0", label: "settings.sv_pureLevel.choices.0" },
            { value: "1", label: "settings.sv_pureLevel.choices.1" },
            { value: "2", label: "settings.sv_pureLevel.choices.2" }
        ]
    },
    {
        key: "sv_endpointprivacy",
        prefix: "",
        label: "settings.sv_endpointprivacy.label",
        hint: "settings.sv_endpointprivacy.hint",
        type: "boolean",
        group: PLAYERS,
        fallback: "off"
    },
    {
        key: "sv_authMaxVariance",
        prefix: "",
        label: "settings.sv_authMaxVariance.label",
        hint: "settings.sv_authMaxVariance.hint",
        type: "number",
        group: PLAYERS,
        fallback: "1",
        min: 1,
        max: 5
    },
    {
        key: "sv_authMinTrust",
        prefix: "",
        label: "settings.sv_authMinTrust.label",
        hint: "settings.sv_authMinTrust.hint",
        type: "number",
        group: PLAYERS,
        fallback: "1",
        min: 1,
        max: 5
    },
    {
        key: "steam_webApiKey",
        prefix: "set",
        label: "settings.steam_webApiKey.label",
        hint: "settings.steam_webApiKey.hint",
        type: "text",
        group: PLAYERS,
        fallback: "none",
        secret: true,
        maxLength: 64
    },
    {
        key: "sv_master1",
        prefix: "",
        label: "settings.sv_master1.label",
        hint: "settings.sv_master1.hint",
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
        label: "settings.sv_projectName.label",
        hint: "settings.sv_projectName.hint",
        type: "text",
        group: LISTING,
        fallback: "none",
        maxLength: 64
    },
    {
        key: "sv_projectDesc",
        prefix: "sets",
        label: "settings.sv_projectDesc.label",
        hint: "settings.sv_projectDesc.hint",
        type: "text",
        group: LISTING,
        fallback: "none",
        maxLength: 128
    },
    {
        key: "locale",
        prefix: "sets",
        label: "settings.locale.label",
        hint: "settings.locale.hint",
        type: "text",
        group: LISTING,
        fallback: "none",
        maxLength: 16
    },
    {
        key: "tags",
        prefix: "sets",
        label: "settings.tags.label",
        hint: "settings.tags.hint",
        type: "text",
        group: LISTING,
        fallback: "none",
        maxLength: 128
    }
];

/** The groups in the order the screen shows them. */
export const FIVEM_SETTING_GROUPS: readonly GameKey<"fivem">[] = [SERVER, GAMEPLAY, PLAYERS, LISTING];

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
export function settingError(
    setting: FivemSetting,
    value: string,
    t: Translator<GameKey<"fivem">> = gameCatalogs.translator("en-US", "fivem")
): string | null {
    if (value.includes("\"")) return t("settingErrors.quote");
    if (/[\r\n]/.test(value)) return t("settingErrors.oneLine");
    switch (setting.type) {
        case "number": {
            if (value.trim().length === 0) return null;
            const number = Number(value);
            if (!Number.isInteger(number)) return t("settingErrors.whole");
            if (setting.min !== undefined && number < setting.min) return t("settingErrors.lowest", { min: setting.min });
            if (setting.max !== undefined && number > setting.max) return t("settingErrors.highest", { max: setting.max });
            return null;
        }
        case "choice":
            return value.trim().length === 0 || setting.choices?.some((choice) => choice.value === value)
                ? null
                : t("settingErrors.notAnOption");
        case "text":
            return setting.maxLength !== undefined && value.length > setting.maxLength
                ? t("settingErrors.tooLong", { max: setting.maxLength })
                : null;
        default:
            return null;
    }
}
