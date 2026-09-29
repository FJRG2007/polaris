/**
 * The rules an ARK server is played under, and where they are actually written.
 *
 * ARK has no live equivalent of Minecraft's `/gamerule`: everything here is read
 * when the server starts and nothing can be changed underneath a running world.
 * Worse, the obvious place to write them - `GameUserSettings.ini` - is rewritten
 * by the game itself when it shuts down, so an edit made while the server is up is
 * quietly thrown away at the exact moment it was supposed to take effect. That is
 * the single most common way an ARK setting "does not work".
 *
 * So Polaris writes them where the game cannot overwrite them: the launch options.
 * The image drives the server through arkmanager, whose instance config turns every
 * `ark_<Name>=<value>` line into a `?<Name>=<value>` on the command line, and a
 * value on the command line wins over the file and is what the game then saves back
 * into it. One file, plain key and value, read at start and written by nobody else.
 *
 * The catalogue is deliberately only the settings that are command-line options -
 * `[ServerSettings]`, in the game's terms. The ones that live in `Game.ini` (how
 * fast a baby grows, what an engram costs) are not query options, and offering them
 * here would be offering switches that change nothing.
 *
 * Pure: the screen validates a value against exactly what the action re-checks it
 * with, and the file this writes is parsed by the same code that formats it.
 */

import type { GameKey } from "../../../messages";

/** What a setting holds. ARK's config is untyped text; these are what the screen
 *  draws and what a value is checked against. */
export type ArkSettingType = "boolean" | "number";

export interface ArkSetting {
    /** The name the game takes, spelled exactly as the game spells it. */
    readonly key: string;
    /** Its name, as a key into the `ark` catalog. */
    readonly label: GameKey<"ark">;
    /** One line saying what it does, in the terms somebody changing it thinks in -
     *  a key into the `ark` catalog, or empty for none. */
    readonly hint: GameKey<"ark"> | "";
    readonly type: ArkSettingType;
    /** The heading it sits under, as a key into the `ark` catalog. */
    readonly group: GameKey<"ark">;
    /** What the game does when nothing sets it, as text, so a row can say what
     *  "unset" means rather than showing an empty box. */
    readonly fallback: string;
    /** For a number, the range the screen will accept. Deliberately wider than
     *  anything sensible: this is a bound on nonsense, not on taste. */
    readonly min?: number;
    readonly max?: number;
    /** Whether it takes a fraction. A multiplier does; a period in seconds does
     *  not. */
    readonly decimal?: boolean;
    /**
     * Whether the game's own switch is named the wrong way round.
     *
     * A handful of ARK's settings are `DisableSomething`, so writing True forbids
     * the thing. The screen still draws every switch as "on means allowed" -
     * mixing the two polarities in one list is how somebody turns gamma on and
     * finds it off - and the value written to the file is flipped back here.
     */
    readonly invert?: boolean;
}

/** What a boolean setting is, as text, when nothing has set it: whatever the game
 *  does by itself. `fallback` describes the behaviour, so an inverted setting's
 *  raw default is the opposite of how it reads. */
export function defaultRawValue(setting: ArkSetting): string {
    if (setting.type !== "boolean") return "";
    const on = setting.fallback === "on";
    return (setting.invert ? !on : on) ? "True" : "False";
}

/** Whether a switch should be drawn as on, given the value in the file. */
export function switchIsOn(setting: ArkSetting, raw: string): boolean {
    const value = (raw || defaultRawValue(setting)).toLowerCase() === "true";
    return setting.invert ? !value : value;
}

/** What to write for a switch somebody has just moved. */
export function switchValue(setting: ArkSetting, on: boolean): string {
    return (setting.invert ? !on : on) ? "True" : "False";
}

const RATES = "settingGroups.rates";
const COMBAT = "settingGroups.damage";
const SURVIVAL = "settingGroups.survival";
const WORLD = "settingGroups.world";
const PLAYING = "settingGroups.playing";
const STRUCTURES = "settingGroups.structures";

/**
 * The settings the screen offers.
 *
 * Every one of them is a `?Key=Value` launch option, which is what makes this list
 * the list rather than a selection of everything ARK can be configured with.
 * Ordered within each group by how often somebody comes looking for it.
 */
export const ARK_SETTINGS: readonly ArkSetting[] = [
    {
        key: "XPMultiplier",
        label: "settings.XPMultiplier.label",
        hint: "settings.XPMultiplier.hint",
        type: "number",
        group: RATES,
        fallback: "1",
        min: 0,
        max: 1000,
        decimal: true
    },
    {
        key: "TamingSpeedMultiplier",
        label: "settings.TamingSpeedMultiplier.label",
        hint: "settings.TamingSpeedMultiplier.hint",
        type: "number",
        group: RATES,
        fallback: "1",
        min: 0,
        max: 1000,
        decimal: true
    },
    {
        key: "HarvestAmountMultiplier",
        label: "settings.HarvestAmountMultiplier.label",
        hint: "settings.HarvestAmountMultiplier.hint",
        type: "number",
        group: RATES,
        fallback: "1",
        min: 0,
        max: 1000,
        decimal: true
    },
    {
        key: "HarvestHealthMultiplier",
        label: "settings.HarvestHealthMultiplier.label",
        hint: "settings.HarvestHealthMultiplier.hint",
        type: "number",
        group: RATES,
        fallback: "1",
        min: 0,
        max: 1000,
        decimal: true
    },
    {
        key: "ResourcesRespawnPeriodMultiplier",
        label: "settings.ResourcesRespawnPeriodMultiplier.label",
        hint: "settings.ResourcesRespawnPeriodMultiplier.hint",
        type: "number",
        group: RATES,
        fallback: "1",
        min: 0,
        max: 1000,
        decimal: true
    },
    {
        key: "ItemStackSizeMultiplier",
        label: "settings.ItemStackSizeMultiplier.label",
        hint: "settings.ItemStackSizeMultiplier.hint",
        type: "number",
        group: RATES,
        fallback: "1",
        min: 0,
        max: 1000,
        decimal: true
    },
    {
        key: "PlayerDamageMultiplier",
        label: "settings.PlayerDamageMultiplier.label",
        hint: "",
        type: "number",
        group: COMBAT,
        fallback: "1",
        min: 0,
        max: 100,
        decimal: true
    },
    {
        key: "PlayerResistanceMultiplier",
        label: "settings.PlayerResistanceMultiplier.label",
        hint: "settings.PlayerResistanceMultiplier.hint",
        type: "number",
        group: COMBAT,
        fallback: "1",
        min: 0,
        max: 100,
        decimal: true
    },
    {
        key: "DinoDamageMultiplier",
        label: "settings.DinoDamageMultiplier.label",
        hint: "",
        type: "number",
        group: COMBAT,
        fallback: "1",
        min: 0,
        max: 100,
        decimal: true
    },
    {
        key: "DinoResistanceMultiplier",
        label: "settings.DinoResistanceMultiplier.label",
        hint: "settings.DinoResistanceMultiplier.hint",
        type: "number",
        group: COMBAT,
        fallback: "1",
        min: 0,
        max: 100,
        decimal: true
    },
    {
        key: "StructureDamageMultiplier",
        label: "settings.StructureDamageMultiplier.label",
        hint: "settings.StructureDamageMultiplier.hint",
        type: "number",
        group: COMBAT,
        fallback: "1",
        min: 0,
        max: 100,
        decimal: true
    },
    {
        key: "StructureResistanceMultiplier",
        label: "settings.StructureResistanceMultiplier.label",
        hint: "settings.StructureResistanceMultiplier.hint",
        type: "number",
        group: COMBAT,
        fallback: "1",
        min: 0,
        max: 100,
        decimal: true
    },
    {
        key: "PlayerCharacterFoodDrainMultiplier",
        label: "settings.PlayerCharacterFoodDrainMultiplier.label",
        hint: "",
        type: "number",
        group: SURVIVAL,
        fallback: "1",
        min: 0,
        max: 100,
        decimal: true
    },
    {
        key: "PlayerCharacterWaterDrainMultiplier",
        label: "settings.PlayerCharacterWaterDrainMultiplier.label",
        hint: "",
        type: "number",
        group: SURVIVAL,
        fallback: "1",
        min: 0,
        max: 100,
        decimal: true
    },
    {
        key: "PlayerCharacterStaminaDrainMultiplier",
        label: "settings.PlayerCharacterStaminaDrainMultiplier.label",
        hint: "",
        type: "number",
        group: SURVIVAL,
        fallback: "1",
        min: 0,
        max: 100,
        decimal: true
    },
    {
        key: "PlayerCharacterHealthRecoveryMultiplier",
        label: "settings.PlayerCharacterHealthRecoveryMultiplier.label",
        hint: "",
        type: "number",
        group: SURVIVAL,
        fallback: "1",
        min: 0,
        max: 100,
        decimal: true
    },
    {
        key: "DinoCharacterFoodDrainMultiplier",
        label: "settings.DinoCharacterFoodDrainMultiplier.label",
        hint: "settings.DinoCharacterFoodDrainMultiplier.hint",
        type: "number",
        group: SURVIVAL,
        fallback: "1",
        min: 0,
        max: 100,
        decimal: true
    },
    {
        key: "OverrideOfficialDifficulty",
        label: "settings.OverrideOfficialDifficulty.label",
        hint: "settings.OverrideOfficialDifficulty.hint",
        type: "number",
        group: WORLD,
        fallback: "off",
        min: 0,
        max: 100,
        decimal: true
    },
    {
        key: "DifficultyOffset",
        label: "settings.DifficultyOffset.label",
        hint: "settings.DifficultyOffset.hint",
        type: "number",
        group: WORLD,
        fallback: "0.2",
        min: 0,
        max: 1,
        decimal: true
    },
    {
        key: "DayCycleSpeedScale",
        label: "settings.DayCycleSpeedScale.label",
        hint: "",
        type: "number",
        group: WORLD,
        fallback: "1",
        min: 0,
        max: 100,
        decimal: true
    },
    {
        key: "NightTimeSpeedScale",
        label: "settings.NightTimeSpeedScale.label",
        hint: "settings.NightTimeSpeedScale.hint",
        type: "number",
        group: WORLD,
        fallback: "1",
        min: 0,
        max: 100,
        decimal: true
    },
    {
        key: "DayTimeSpeedScale",
        label: "settings.DayTimeSpeedScale.label",
        hint: "",
        type: "number",
        group: WORLD,
        fallback: "1",
        min: 0,
        max: 100,
        decimal: true
    },
    {
        key: "ServerPVE",
        label: "settings.ServerPVE.label",
        hint: "settings.ServerPVE.hint",
        type: "boolean",
        group: WORLD,
        fallback: "off"
    },
    {
        key: "ServerHardcore",
        label: "settings.ServerHardcore.label",
        hint: "settings.ServerHardcore.hint",
        type: "boolean",
        group: WORLD,
        fallback: "off"
    },
    {
        key: "AutoSavePeriodMinutes",
        label: "settings.AutoSavePeriodMinutes.label",
        hint: "settings.AutoSavePeriodMinutes.hint",
        type: "number",
        group: WORLD,
        fallback: "15",
        min: 1,
        max: 240,
        decimal: true
    },
    {
        key: "KickIdlePlayersPeriod",
        label: "settings.KickIdlePlayersPeriod.label",
        hint: "settings.KickIdlePlayersPeriod.hint",
        type: "number",
        group: WORLD,
        fallback: "3600",
        min: 60,
        max: 86400
    },
    {
        key: "ShowMapPlayerLocation",
        label: "settings.ShowMapPlayerLocation.label",
        hint: "settings.ShowMapPlayerLocation.hint",
        type: "boolean",
        group: PLAYING,
        fallback: "on"
    },
    {
        key: "AllowThirdPersonPlayer",
        label: "settings.AllowThirdPersonPlayer.label",
        hint: "",
        type: "boolean",
        group: PLAYING,
        fallback: "on"
    },
    {
        key: "ServerCrosshair",
        label: "settings.ServerCrosshair.label",
        hint: "",
        type: "boolean",
        group: PLAYING,
        fallback: "off"
    },
    {
        key: "EnablePvPGamma",
        label: "settings.EnablePvPGamma.label",
        hint: "settings.EnablePvPGamma.hint",
        type: "boolean",
        group: PLAYING,
        fallback: "off"
    },
    {
        // The other half of the same question, and the reason turning gamma on
        // appears not to work: the two settings cover different modes and are
        // named with opposite polarity, so a PvE server with only the PvP one set
        // still refuses the command. Shown the right way round - on means allowed -
        // because a switch labelled with a double negative is how this was got
        // wrong in the first place.
        key: "DisablePvEGamma",
        label: "settings.DisablePvEGamma.label",
        hint: "settings.DisablePvEGamma.hint",
        type: "boolean",
        group: PLAYING,
        fallback: "on",
        invert: true
    },
    {
        key: "ShowFloatingDamageText",
        label: "settings.ShowFloatingDamageText.label",
        hint: "settings.ShowFloatingDamageText.hint",
        type: "boolean",
        group: PLAYING,
        fallback: "off"
    },
    {
        key: "AllowHitMarkers",
        label: "settings.AllowHitMarkers.label",
        hint: "",
        type: "boolean",
        group: PLAYING,
        fallback: "on"
    },
    {
        key: "GlobalVoiceChat",
        label: "settings.GlobalVoiceChat.label",
        hint: "settings.GlobalVoiceChat.hint",
        type: "boolean",
        group: PLAYING,
        fallback: "off"
    },
    {
        key: "AlwaysAllowStructurePickup",
        label: "settings.AlwaysAllowStructurePickup.label",
        hint: "settings.AlwaysAllowStructurePickup.hint",
        type: "boolean",
        group: STRUCTURES,
        fallback: "off"
    },
    {
        key: "DisableStructureDecayPvE",
        label: "settings.DisableStructureDecayPvE.label",
        hint: "settings.DisableStructureDecayPvE.hint",
        type: "boolean",
        group: STRUCTURES,
        fallback: "off"
    },
    {
        key: "AllowCaveBuildingPvE",
        label: "settings.AllowCaveBuildingPvE.label",
        hint: "",
        type: "boolean",
        group: STRUCTURES,
        fallback: "off"
    },
    {
        key: "AllowFlyerCarryPvE",
        label: "settings.AllowFlyerCarryPvE.label",
        hint: "settings.AllowFlyerCarryPvE.hint",
        type: "boolean",
        group: STRUCTURES,
        fallback: "off"
    },
    {
        key: "StructurePreventResourceRadiusMultiplier",
        label: "settings.StructurePreventResourceRadiusMultiplier.label",
        hint: "settings.StructurePreventResourceRadiusMultiplier.hint",
        type: "number",
        group: STRUCTURES,
        fallback: "1",
        min: 0,
        max: 100,
        decimal: true
    },
    {
        key: "TheMaxStructuresInRange",
        label: "settings.TheMaxStructuresInRange.label",
        hint: "settings.TheMaxStructuresInRange.hint",
        type: "number",
        group: STRUCTURES,
        fallback: "10500",
        min: 100,
        max: 500000
    }
];

export function findArkSetting(key: string): ArkSetting | undefined {
    return ARK_SETTINGS.find((setting) => setting.key === key);
}

/** The settings a screen draws, in the order the groups are declared. */
export function arkSettingGroups(): { group: GameKey<"ark">; settings: ArkSetting[] }[] {
    const groups: { group: GameKey<"ark">; settings: ArkSetting[] }[] = [];
    for (const setting of ARK_SETTINGS) {
        const existing = groups.find((entry) => entry.group === setting.group);
        if (existing) existing.settings.push(setting);
        else groups.push({ group: setting.group, settings: [setting] });
    }
    return groups;
}

/**
 * What a new server is set to, unless somebody says otherwise.
 *
 * Nothing about how hard the game is - that is the operator's to choose, and a
 * server that quietly triples its own rates is a server nobody can reason about.
 * These are the four that are only ever off because ARK's defaults were written for
 * public servers in 2015: a map that shows you where you are, a camera you can turn
 * around, a crosshair, and a brightness slider so the nights are playable.
 */
export const RECOMMENDED_ARK_SETTINGS: Readonly<Record<string, string>> = {
    ShowMapPlayerLocation: "True",
    AllowThirdPersonPlayer: "True",
    ServerCrosshair: "True",
    // Both halves of the gamma question. ARK covers PvP and PvE with two settings
    // named the opposite way round, and setting only the first is a server where
    // turning gamma on demonstrably does nothing.
    EnablePvPGamma: "True",
    DisablePvEGamma: "False"
};

/**
 * Which generation of the recommended set a server has been given.
 *
 * A number rather than a flag because the set grows: when something is added to
 * it - as the PvE half of the gamma pair was - every server that was seeded under
 * the older list has to be offered the new entries once, and a boolean can only
 * ever say "already done". Nothing already set is touched either way, so a raised
 * version never overrides a decision.
 */
export const RECOMMENDED_ARK_VERSION = 2;

/** Where the settings a server was created with, and has not been given yet, are
 *  kept on the install. A new server has no container to write them into. */
export const ARK_PENDING_SETTINGS_KEY = "arkPendingSettings";

/** Which generation of the recommended set this server has been offered. A server
 *  is never offered the same generation twice, so a setting somebody deliberately
 *  unpinned does not come back on the next sweep. Servers seeded before this was a
 *  number carry `true`, which reads as generation 1. */
export const ARK_SETTINGS_SEEDED_KEY = "arkSettingsSeeded";

/** What that key says, as a number. */
export function seededVersion(config: Record<string, unknown>): number {
    const raw = config[ARK_SETTINGS_SEEDED_KEY];
    if (raw === true) return 1;
    return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

/** Where the overrides live, relative to the volume the image keeps its files in.
 *  arkmanager reads this file at every start and nothing else writes to it. */
export const INSTANCE_CONFIG_PATH = "arkmanager/instances/main.cfg";

/** Where the game keeps the settings it manages itself, relative to the server
 *  root. Read to say what the world is actually running with; never written -
 *  the game rewrites it when it stops. */
export const GAME_USER_SETTINGS_PATH = "ShooterGame/Saved/Config/LinuxServer/GameUserSettings.ini";

/** How an override is written into the instance config: arkmanager turns each
 *  `ark_<Name>` into a `?<Name>=<value>` on the command line. */
const OVERRIDE_LINE = /^\s*ark_([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/;

/**
 * A value this setting can hold, or null.
 *
 * The screen checks with this before offering to save and the action checks with it
 * again before writing: everything is text by the time it reaches the file, and
 * `True` for a multiplier is a server that refuses to start.
 */
export function normalizeArkValue(setting: ArkSetting, raw: string): string | null {
    const value = raw.trim();
    if (setting.type === "boolean") {
        const lowered = value.toLowerCase();
        if (lowered === "true" || lowered === "false") return lowered === "true" ? "True" : "False";
        return null;
    }
    if (!(setting.decimal ? /^\d{1,7}(\.\d{1,4})?$/ : /^\d{1,9}$/).test(value)) return null;
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    if (setting.min !== undefined && number < setting.min) return null;
    if (setting.max !== undefined && number > setting.max) return null;
    // Written back as it was typed rather than as JavaScript would print it: `1.50`
    // and `1.5` are the same setting, and rewriting somebody's number is a diff
    // nobody asked for.
    return value;
}

/**
 * The overrides Polaris manages, out of the instance config.
 *
 * Only the ones in the catalogue: the same file carries the server's name, its
 * ports and its passwords, and none of those belong to this screen.
 */
export function parseArkOverrides(config: string): Record<string, string> {
    const found: Record<string, string> = {};
    for (const line of config.split(/\r?\n/)) {
        if (line.trimStart().startsWith("#")) continue;
        const match = OVERRIDE_LINE.exec(line);
        const key = match?.[1];
        if (!key || !findArkSetting(key)) continue;
        // Quotes are legal in this file - it is read by a shell - and are not part
        // of the value.
        found[key] = (match[2] ?? "").replace(/^["']|["']$/g, "");
    }
    return found;
}

/** The heading Polaris writes its own lines under, so a person reading the file
 *  knows which half is theirs. */
const BLOCK_HEADING = "# Settings managed by Polaris. Edit them from the server's Rules screen.";

/**
 * The instance config with these overrides in it, and every other line of it
 * exactly as it was.
 *
 * A line for a setting Polaris manages is rewritten in place, one that is being
 * unset is dropped, and anything new is appended under a heading. Nothing else is
 * touched: this file also carries the server's ports, its passwords and whatever
 * the operator added by hand, and none of that is this screen's to rewrite.
 */
export function writeArkOverrides(config: string, overrides: Readonly<Record<string, string>>): string {
    const remaining = new Map(Object.entries(overrides));
    const lines = config.split(/\r?\n/);
    const kept: string[] = [];
    for (const line of lines) {
        const match = OVERRIDE_LINE.exec(line);
        const key = match?.[1];
        if (!key || !findArkSetting(key) || line.trimStart().startsWith("#")) {
            kept.push(line);
            continue;
        }
        if (!remaining.has(key)) continue;
        kept.push(`ark_${key}=${remaining.get(key) ?? ""}`);
        remaining.delete(key);
    }
    // Trailing blank lines are where an appended block would otherwise leave a gap
    // that grows by one on every save.
    while (kept.length > 0 && (kept[kept.length - 1] ?? "").trim().length === 0) kept.pop();
    if (remaining.size > 0) {
        if (!kept.includes(BLOCK_HEADING)) kept.push("", BLOCK_HEADING);
        for (const [key, value] of remaining) kept.push(`ark_${key}=${value}`);
    }
    return `${kept.join("\n")}\n`;
}

/**
 * The values one section of an ini file holds.
 *
 * Enough of an ini parser for what this reads and no more: ARK writes one
 * `Key=Value` per line under a `[Section]` heading, and the only thing wanted here
 * is what the game currently believes about the settings in the catalogue.
 */
export function parseIniSection(content: string, section: string): Record<string, string> {
    const values: Record<string, string> = {};
    let inside = false;
    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith("[")) {
            inside = trimmed.toLowerCase() === `[${section.toLowerCase()}]`;
            continue;
        }
        if (!inside || trimmed.length === 0 || trimmed.startsWith(";") || trimmed.startsWith("#")) continue;
        const split = trimmed.indexOf("=");
        if (split <= 0) continue;
        values[trimmed.slice(0, split).trim()] = trimmed.slice(split + 1).trim();
    }
    return values;
}
