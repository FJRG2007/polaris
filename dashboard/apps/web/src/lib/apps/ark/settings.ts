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

/** What a setting holds. ARK's config is untyped text; these are what the screen
 *  draws and what a value is checked against. */
export type ArkSettingType = "boolean" | "number";

export interface ArkSetting {
    /** The name the game takes, spelled exactly as the game spells it. */
    readonly key: string;
    readonly label: string;
    /** One line saying what it does, in the terms somebody changing it thinks in. */
    readonly hint: string;
    readonly type: ArkSettingType;
    /** The heading it sits under. */
    readonly group: string;
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

const RATES = "Rates";
const COMBAT = "Damage";
const SURVIVAL = "Survival";
const WORLD = "World";
const PLAYING = "Playing";
const STRUCTURES = "Structures";

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
        label: "Experience",
        hint: "How fast players and tames level. 3 is the usual boosted server.",
        type: "number",
        group: RATES,
        fallback: "1",
        min: 0,
        max: 1000,
        decimal: true
    },
    {
        key: "TamingSpeedMultiplier",
        label: "Taming speed",
        hint: "Higher tames faster. The single most changed setting on a private server.",
        type: "number",
        group: RATES,
        fallback: "1",
        min: 0,
        max: 1000,
        decimal: true
    },
    {
        key: "HarvestAmountMultiplier",
        label: "Harvest amount",
        hint: "How much wood, stone and hide one hit gives.",
        type: "number",
        group: RATES,
        fallback: "1",
        min: 0,
        max: 1000,
        decimal: true
    },
    {
        key: "HarvestHealthMultiplier",
        label: "Resource health",
        hint: "How much a tree or rock takes before it is used up. Higher means more from each.",
        type: "number",
        group: RATES,
        fallback: "1",
        min: 0,
        max: 1000,
        decimal: true
    },
    {
        key: "ResourcesRespawnPeriodMultiplier",
        label: "Resource respawn wait",
        hint: "Lower brings trees and rocks back sooner.",
        type: "number",
        group: RATES,
        fallback: "1",
        min: 0,
        max: 1000,
        decimal: true
    },
    {
        key: "ItemStackSizeMultiplier",
        label: "Stack size",
        hint: "How much fits in one slot. Changing it later does not restack what is already in a box.",
        type: "number",
        group: RATES,
        fallback: "1",
        min: 0,
        max: 1000,
        decimal: true
    },
    {
        key: "PlayerDamageMultiplier",
        label: "Damage players deal",
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
        label: "Damage players take",
        hint: "Higher means they take more, not less.",
        type: "number",
        group: COMBAT,
        fallback: "1",
        min: 0,
        max: 100,
        decimal: true
    },
    {
        key: "DinoDamageMultiplier",
        label: "Damage wild creatures deal",
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
        label: "Damage wild creatures take",
        hint: "Higher means they take more.",
        type: "number",
        group: COMBAT,
        fallback: "1",
        min: 0,
        max: 100,
        decimal: true
    },
    {
        key: "StructureDamageMultiplier",
        label: "Damage structures deal",
        hint: "Spike walls and turrets.",
        type: "number",
        group: COMBAT,
        fallback: "1",
        min: 0,
        max: 100,
        decimal: true
    },
    {
        key: "StructureResistanceMultiplier",
        label: "Damage structures take",
        hint: "Higher means buildings come apart faster.",
        type: "number",
        group: COMBAT,
        fallback: "1",
        min: 0,
        max: 100,
        decimal: true
    },
    {
        key: "PlayerCharacterFoodDrainMultiplier",
        label: "How fast players get hungry",
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
        label: "How fast players get thirsty",
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
        label: "How fast players tire",
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
        label: "How fast players heal",
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
        label: "How fast tames get hungry",
        hint: "Lower means less time spent filling troughs.",
        type: "number",
        group: SURVIVAL,
        fallback: "1",
        min: 0,
        max: 100,
        decimal: true
    },
    {
        key: "DifficultyOffset",
        label: "Difficulty offset",
        hint: "Between 0 and 1. With the override below, this is what decides wild creature levels.",
        type: "number",
        group: WORLD,
        fallback: "0.2",
        min: 0,
        max: 1,
        decimal: true
    },
    {
        key: "OverrideOfficialDifficulty",
        label: "Difficulty",
        hint: "5 is the usual choice: wild creatures up to level 150.",
        type: "number",
        group: WORLD,
        fallback: "off",
        min: 0,
        max: 100,
        decimal: true
    },
    {
        key: "DayCycleSpeedScale",
        label: "How fast the day passes",
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
        label: "How fast the night passes",
        hint: "Higher makes nights shorter.",
        type: "number",
        group: WORLD,
        fallback: "1",
        min: 0,
        max: 100,
        decimal: true
    },
    {
        key: "DayTimeSpeedScale",
        label: "How fast the daylight passes",
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
        label: "Players cannot hurt each other",
        hint: "On makes it a PvE server.",
        type: "boolean",
        group: WORLD,
        fallback: "off"
    },
    {
        key: "ServerHardcore",
        label: "Death is permanent",
        hint: "A player who dies starts again at level 1.",
        type: "boolean",
        group: WORLD,
        fallback: "off"
    },
    {
        key: "AutoSavePeriodMinutes",
        label: "Save the world every",
        hint: "Minutes. Shorter loses less in a crash and costs a pause each time.",
        type: "number",
        group: WORLD,
        fallback: "15",
        min: 1,
        max: 240,
        decimal: true
    },
    {
        key: "KickIdlePlayersPeriod",
        label: "Throw idle players out after",
        hint: "Seconds. Only applies while the server is full of people who are actually playing.",
        type: "number",
        group: WORLD,
        fallback: "3600",
        min: 60,
        max: 86400
    },
    {
        key: "ShowMapPlayerLocation",
        label: "Show players where they are",
        hint: "Their own position, and their tribe's, on the map. Off, the map is a picture.",
        type: "boolean",
        group: PLAYING,
        fallback: "on"
    },
    {
        key: "AllowThirdPersonPlayer",
        label: "Third person camera",
        hint: "",
        type: "boolean",
        group: PLAYING,
        fallback: "on"
    },
    {
        key: "ServerCrosshair",
        label: "Crosshair",
        hint: "",
        type: "boolean",
        group: PLAYING,
        fallback: "off"
    },
    {
        key: "EnablePvPGamma",
        label: "Let players change their gamma while PvP is on",
        hint: "Their own brightness, set with the gamma command in game. Off, nights are genuinely dark - and unplayable for some people.",
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
        label: "Let players change their gamma while PvE is on",
        hint: "The same thing for a PvE server, which is a separate setting in the game. Both are worth leaving on.",
        type: "boolean",
        group: PLAYING,
        fallback: "on",
        invert: true
    },
    {
        key: "ShowFloatingDamageText",
        label: "Show damage numbers",
        hint: "The RPG-style numbers over whatever was hit.",
        type: "boolean",
        group: PLAYING,
        fallback: "off"
    },
    {
        key: "AllowHitMarkers",
        label: "Show hit markers",
        hint: "",
        type: "boolean",
        group: PLAYING,
        fallback: "on"
    },
    {
        key: "GlobalVoiceChat",
        label: "Voice chat reaches the whole server",
        hint: "Off, it only reaches people nearby.",
        type: "boolean",
        group: PLAYING,
        fallback: "off"
    },
    {
        key: "AlwaysAllowStructurePickup",
        label: "Pick structures back up at any time",
        hint: "Off, only within the first few seconds of placing one.",
        type: "boolean",
        group: STRUCTURES,
        fallback: "off"
    },
    {
        key: "DisableStructureDecayPvE",
        label: "Buildings never decay",
        hint: "On a server people play on a few nights a week, this is what stops bases falling down.",
        type: "boolean",
        group: STRUCTURES,
        fallback: "off"
    },
    {
        key: "AllowCaveBuildingPvE",
        label: "Building in caves",
        hint: "",
        type: "boolean",
        group: STRUCTURES,
        fallback: "off"
    },
    {
        key: "AllowFlyerCarryPvE",
        label: "Flyers can pick things up",
        hint: "Including wild creatures and other players' tames.",
        type: "boolean",
        group: STRUCTURES,
        fallback: "off"
    },
    {
        key: "StructurePreventResourceRadiusMultiplier",
        label: "How far a building stops resources growing",
        hint: "Lower lets trees come back closer to a base.",
        type: "number",
        group: STRUCTURES,
        fallback: "1",
        min: 0,
        max: 100,
        decimal: true
    },
    {
        key: "TheMaxStructuresInRange",
        label: "Most structures in one area",
        hint: "The ceiling on how big one base can get.",
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
export function arkSettingGroups(): { group: string; settings: ArkSetting[] }[] {
    const groups: { group: string; settings: ArkSetting[] }[] = [];
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
