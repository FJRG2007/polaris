/**
 * The rules a world is played under, and the ones worth putting on a screen.
 *
 * Minecraft has around forty game rules and most of them are debug switches. An
 * operator opening this is nearly always after one of a dozen: whether a death
 * costs you your bag, whether the sun moves, whether creepers take the wall out.
 * So the list is curated and grouped rather than dumped, and everything here is a
 * rule the game applies the moment it is set - no restart, nobody disconnected.
 *
 * Which of them a server actually has depends on its version: `doImmediateRespawn`
 * arrived in 1.15 and `playersSleepingPercentage` in 1.17. Nothing here assumes -
 * the server is asked for each one and answers for the ones it knows, so what is
 * drawn is what that particular server can be told.
 *
 * Pure: the catalogue, the reply format and the validation, with no transport, so
 * the screen and the action check a value against the same rules.
 */

/** What a rule holds. Minecraft has only these two kinds. */
export type GameRuleType = "boolean" | "integer";

export interface GameRule {
    /** The name the command takes, exactly as the game spells it. */
    readonly id: string;
    readonly label: string;
    /** One line saying what turning it on does. */
    readonly hint: string;
    readonly type: GameRuleType;
    /** The heading it sits under. */
    readonly group: string;
    /** For an integer rule, the range the screen will accept. */
    readonly min?: number;
    readonly max?: number;
}

const DEATH = "Death and respawn";
const DAMAGE = "Damage";
const WORLD = "World";
const MOBS = "Mobs";
const PLAY = "Playing";

/**
 * The rules the screen offers.
 *
 * Ordered within each group by how often somebody comes looking for it, which is
 * why keepInventory is the first thing on the page.
 */
export const GAME_RULES: readonly GameRule[] = [
    {
        id: "keepInventory",
        label: "Keep inventory on death",
        hint: "Players keep what they were carrying instead of dropping it.",
        type: "boolean",
        group: DEATH
    },
    {
        id: "doImmediateRespawn",
        label: "Respawn immediately",
        hint: "Skips the death screen and puts them straight back in.",
        type: "boolean",
        group: DEATH
    },
    {
        id: "showDeathMessages",
        label: "Announce deaths in chat",
        hint: "",
        type: "boolean",
        group: DEATH
    },
    {
        id: "spawnRadius",
        label: "Spawn spread",
        hint: "How many blocks around the world spawn players can appear in.",
        type: "integer",
        group: DEATH,
        min: 0,
        max: 128
    },
    { id: "fallDamage", label: "Fall damage", hint: "", type: "boolean", group: DAMAGE },
    { id: "fireDamage", label: "Fire damage", hint: "", type: "boolean", group: DAMAGE },
    { id: "drowningDamage", label: "Drowning damage", hint: "", type: "boolean", group: DAMAGE },
    {
        id: "naturalRegeneration",
        label: "Heal from a full hunger bar",
        hint: "Off makes food the only way back to full health.",
        type: "boolean",
        group: DAMAGE
    },
    {
        id: "mobGriefing",
        label: "Mobs can change the world",
        hint: "Creeper craters, endermen moving blocks, zombies breaking doors.",
        type: "boolean",
        group: WORLD
    },
    {
        id: "doFireTick",
        label: "Fire spreads",
        hint: "",
        type: "boolean",
        group: WORLD
    },
    { id: "doDaylightCycle", label: "Time passes", hint: "Off freezes the sun where it is.", type: "boolean", group: WORLD },
    { id: "doWeatherCycle", label: "Weather changes", hint: "", type: "boolean", group: WORLD },
    {
        id: "randomTickSpeed",
        label: "Growth speed",
        hint: "How fast crops grow and leaves decay. 3 is normal; large numbers cost the server.",
        type: "integer",
        group: WORLD,
        min: 0,
        max: 1000
    },
    {
        id: "playersSleepingPercentage",
        label: "Share of players needed to skip the night",
        hint: "As a percentage. 0 lets one player skip it.",
        type: "integer",
        group: WORLD,
        min: 0,
        max: 100
    },
    { id: "doMobSpawning", label: "Mobs spawn", hint: "", type: "boolean", group: MOBS },
    { id: "doMobLoot", label: "Mobs drop loot", hint: "", type: "boolean", group: MOBS },
    { id: "doInsomnia", label: "Phantoms", hint: "The ones that come for players who have not slept.", type: "boolean", group: MOBS },
    { id: "doPatrolSpawning", label: "Pillager patrols", hint: "", type: "boolean", group: MOBS },
    { id: "doTraderSpawning", label: "Wandering traders", hint: "", type: "boolean", group: MOBS },
    { id: "doWardenSpawning", label: "Wardens", hint: "", type: "boolean", group: MOBS },
    { id: "doTileDrops", label: "Broken blocks drop", hint: "", type: "boolean", group: PLAY },
    {
        id: "doLimitedCrafting",
        label: "Only craft what has been unlocked",
        hint: "Recipes have to be discovered before they can be used.",
        type: "boolean",
        group: PLAY
    },
    { id: "announceAdvancements", label: "Announce advancements", hint: "", type: "boolean", group: PLAY },
    {
        id: "disableRaids",
        label: "No raids",
        hint: "Villages are left alone after a player earns Bad Omen.",
        type: "boolean",
        group: PLAY
    }
];

/** The rules a screen draws, in the order the groups are declared. */
export function ruleGroups(): { group: string; rules: GameRule[] }[] {
    const groups: { group: string; rules: GameRule[] }[] = [];
    for (const rule of GAME_RULES) {
        const existing = groups.find((entry) => entry.group === rule.group);
        if (existing) existing.rules.push(rule);
        else groups.push({ group: rule.group, rules: [rule] });
    }
    return groups;
}

export function findRule(id: string): GameRule | undefined {
    return GAME_RULES.find((rule) => rule.id === id);
}

/** The difficulties the game has, lowest first. Live: `/difficulty` takes effect
 *  without a restart, unlike the `DIFFICULTY` the container was built with. */
export const DIFFICULTIES = ["peaceful", "easy", "normal", "hard"] as const;

export type Difficulty = (typeof DIFFICULTIES)[number];

export function isDifficulty(value: unknown): value is Difficulty {
    return typeof value === "string" && (DIFFICULTIES as readonly string[]).includes(value);
}

/**
 * A value this rule can actually hold, or null.
 *
 * The screen checks with this before offering to save and the action checks with
 * it again before running a command: a rule is a string on the wire either way,
 * and "true" for an integer rule is a command the server refuses.
 */
export function normalizeRuleValue(rule: GameRule, raw: string): string | null {
    const value = raw.trim();
    if (rule.type === "boolean") return value === "true" || value === "false" ? value : null;
    if (!/^-?\d{1,7}$/.test(value)) return null;
    const number = Number(value);
    if (rule.min !== undefined && number < rule.min) return null;
    if (rule.max !== undefined && number > rule.max) return null;
    return String(number);
}

/**
 * What the server said each rule is set to.
 *
 * One reply per rule, in whatever order they came back:
 * `Gamerule keepInventory is currently set to: false`. A rule this version does
 * not have answers with something else entirely and is simply absent from the
 * map - which is what lets the screen draw one server's rules rather than a fixed
 * list with half of it not working.
 */
export function parseGameRules(output: string): Map<string, string> {
    const found = new Map<string, string>();
    for (const match of output.matchAll(/Gamerule ([A-Za-z]+) is (?:currently|now) set to:\s*(\S+)/g)) {
        const [, id, value] = match;
        if (id && value) found.set(id, value);
    }
    return found;
}

/** The difficulty out of `/difficulty` with no argument: "The difficulty is Easy". */
export function parseDifficulty(output: string): Difficulty | null {
    const match = /difficulty is (?:currently )?(\w+)/i.exec(output);
    const value = match?.[1]?.toLowerCase();
    return isDifficulty(value) ? value : null;
}
