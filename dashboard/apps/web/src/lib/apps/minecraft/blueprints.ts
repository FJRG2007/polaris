/**
 * Blueprints: a server that is already something when it starts.
 *
 * A blueprint is a named preset over the same settings the create dialog holds -
 * the software, the world properties, and the plugins the image installs on its
 * first boot. It is not a world download and not content Polaris ships: every
 * plugin named here is a real Modrinth project the image fetches itself, and
 * each carries "?" so a Minecraft release it has no build for yet warns instead
 * of stopping the server from starting.
 *
 * Which is also the honest limit of them. A blueprint gets a server to the game
 * it is for; tuning that game is the plugin's own configuration, on the server's
 * files.
 */

/** The size of world a blueprint expects, which changes what memory it needs. */
export type BlueprintWeight = "light" | "normal" | "heavy";

export interface GameBlueprint {
    readonly id: string;
    readonly name: string;
    readonly summary: string;
    /** Editions it can be created for; a plugin blueprint is Java only. */
    readonly editions: readonly ("java" | "bedrock")[];
    /** Server software it needs. Blank keeps whatever the operator chose. */
    readonly software?: string;
    /** Modrinth projects installed on the first boot, on top of the defaults. */
    readonly projects: readonly string[];
    /** Server properties it sets, as the image's environment. */
    readonly env?: Readonly<Record<string, string>>;
    readonly weight: BlueprintWeight;
}

export const GAME_BLUEPRINTS: readonly GameBlueprint[] = [
    {
        id: "survival",
        name: "Survival",
        summary: "The ordinary game. Nothing added beyond the protection every server gets.",
        editions: ["java", "bedrock"],
        projects: [],
        weight: "normal"
    },
    {
        id: "creative",
        name: "Creative",
        summary: "Everything unlocked and nothing to survive, for building together.",
        editions: ["java", "bedrock"],
        projects: [],
        env: { MODE: "creative", DIFFICULTY: "peaceful", GAMEMODE: "creative" },
        weight: "light"
    },
    {
        id: "skyblock",
        name: "Skyblock",
        summary: "Islands in the void, one block at a time. Installs IridiumSkyblock.",
        editions: ["java"],
        software: "PAPER",
        projects: ["iridiumskyblock?"],
        weight: "normal"
    },
    {
        id: "parkour",
        name: "Infinite parkour",
        summary: "A course that generates as you run it, with times to beat. Installs InfiniteParkour.",
        editions: ["java"],
        software: "PAPER",
        projects: ["infiniteparkour?"],
        env: { MODE: "adventure", DIFFICULTY: "peaceful", PVP: "false" },
        weight: "light"
    },
    {
        id: "bedwars",
        name: "Bed wars",
        summary: "Teams, beds and a lot of shouting. Installs BedWars1058.",
        editions: ["java"],
        software: "PAPER",
        projects: ["bedwars1058?"],
        weight: "heavy"
    },
    {
        id: "shrinking-world",
        name: "Shrinking world",
        summary: "A border that keeps moving, so nobody settles down. Installs DynamicWorldBorder.",
        editions: ["java"],
        software: "PAPER",
        projects: ["dynamicworldborder?"],
        weight: "normal"
    }
];

export function findBlueprint(id: string): GameBlueprint | undefined {
    return GAME_BLUEPRINTS.find((blueprint) => blueprint.id === id);
}

/** Blueprints that can be created for an edition. */
export function blueprintsFor(edition: "java" | "bedrock"): readonly GameBlueprint[] {
    return GAME_BLUEPRINTS.filter((blueprint) => blueprint.editions.includes(edition));
}

/**
 * The plugins that let Bedrock clients join a Java server. Geyser translates the
 * protocol and Floodgate is what lets them in without a Java account; both are
 * GeyserMC's, and both have to be there for it to work.
 */
export const CROSSPLAY_PROJECTS = ["geyser?", "floodgate?"] as const;

/**
 * Memory for a server, from how many people will actually be on it.
 *
 * The number that matters is the concurrent one, not the slot count: a server
 * with 200 slots and eight players on it is an eight-player server. A gigabyte
 * carries the world and the server itself, each player costs about 50 MB of
 * chunks and entities, and a blueprint that runs a minigame engine needs more
 * than one that runs nothing. Rounded to half a gigabyte, because that is the
 * granularity anyone reasons in, and capped at 12 GB - past that the answer is
 * another server, not a bigger heap.
 */
export function recommendedMemoryMb(concurrentPlayers: number, weight: BlueprintWeight = "normal"): number {
    const base = weight === "heavy" ? 2048 : weight === "light" ? 768 : 1024;
    // A parkour course keeps almost nothing per player; a minigame engine keeps
    // scoreboards, arenas and entities for each of them.
    const perPlayer = weight === "heavy" ? 80 : weight === "light" ? 35 : 50;
    const raw = base + Math.max(0, concurrentPlayers) * perPlayer;
    const rounded = Math.ceil(raw / 512) * 512;
    return Math.min(Math.max(rounded, 1536), 12288);
}

/** The same figure as the image wants it ("2G", "2560M"). */
export function formatMemory(megabytes: number): string {
    return megabytes % 1024 === 0 ? `${megabytes / 1024}G` : `${megabytes}M`;
}
