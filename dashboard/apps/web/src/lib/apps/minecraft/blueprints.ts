/**
 * Blueprints: a server that is already something when it starts.
 *
 * A blueprint is a named preset over the same settings the create dialog holds -
 * the software, the world properties, and the plugins the image installs on its
 * first boot. It is not a world download and not content Polaris ships: every
 * plugin named here is a real Modrinth project the image fetches itself.
 *
 * Those entries are deliberately required rather than optional. The image takes a
 * trailing "?" as "warn and carry on", which is right for the protection every
 * server gets and wrong for the one plugin a blueprint exists to install: a Bed
 * wars server whose plugin had no build for the release being installed booted
 * anyway, said so only in its log, and handed back an ordinary survival world
 * that looked exactly like every other server the operator had made. Without the
 * "?" that same case stops the container instead, which is a failure somebody can
 * see and act on. The version is pinned before anything is created (see
 * blueprint-version) so it is not a case that should arise.
 *
 * Which leaves the honest limit of a blueprint, and `setup` is where it is
 * written down: a blueprint gets the plugin onto the server and the world into
 * the right shape for it, and a plugin that has no map of its own still needs one
 * making. Bed wars is the clearest case - it ships no arenas, so until one exists
 * the server really is just a world - and saying so on the server's own page is
 * the difference between "this is broken" and "this is the next step".
 */

import { projectSlug } from "./modrinth";
import { FLAT_LEVEL_TYPE } from "./world";

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
    /**
     * The shape the world is generated in for this game, when the ordinary one is
     * the wrong answer - a minigame's spawn is a lobby, not a survival map.
     *
     * A default rather than a rule: it is what the create dialog starts the world
     * type on, and an operator who picks another one gets the one they picked.
     */
    readonly levelType?: string;
    /** What is still left to do once the server is up, in the plugin rather than
     *  in Polaris. Blank for a blueprint that needs nothing. */
    readonly setup?: string;
    /** The plugin's own instructions, for the part Polaris cannot do. */
    readonly docs?: string;
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
        projects: ["iridiumskyblock"],
        // The islands are worlds the plugin makes and manages itself; what the
        // server generates is only where people land before they have one.
        levelType: FLAT_LEVEL_TYPE,
        setup: "The island worlds are the plugin's own and it creates them on its first start. The world the server generates is only the lobby people land in.",
        docs: "https://docs.iridiumdevelopment.net/",
        weight: "normal"
    },
    {
        id: "parkour",
        name: "Infinite parkour",
        summary: "A course that generates as you run it, with times to beat. Installs InfiniteParkour.",
        editions: ["java"],
        software: "PAPER",
        projects: ["infiniteparkour"],
        env: { MODE: "adventure", DIFFICULTY: "peaceful", PVP: "false" },
        levelType: FLAT_LEVEL_TYPE,
        setup: "Run /parkour in game to start a course. The world the server generates is the lobby; the courses are generated as they are run.",
        docs: "https://efnilite.dev/projects/ip/wiki",
        weight: "light"
    },
    {
        id: "bedwars",
        name: "Bed wars",
        summary: "Teams, beds and a lot of shouting. Installs BedWars1058.",
        editions: ["java"],
        software: "PAPER",
        projects: ["bedwars1058"],
        levelType: FLAT_LEVEL_TYPE,
        // The one blueprint whose game does not exist until somebody makes it. Said
        // plainly, because a server that looks like an empty world is exactly what
        // BedWars1058 with no arena is - not a failed install.
        setup: "BedWars1058 ships no arenas, so until you add one the server is a lobby and nothing else. Take a ready-made setup from the wiki or build a map and register it, then players join with /bw join.",
        docs: "https://wiki.andrei1058.com/docs/BedWars1058/addons",
        weight: "heavy"
    },
    {
        id: "shrinking-world",
        name: "Shrinking world",
        summary: "A border that keeps moving, so nobody settles down. Installs DynamicWorldBorder.",
        editions: ["java"],
        software: "PAPER",
        projects: ["dynamicworldborder"],
        setup: "The border moves on the schedule in the plugin's config, and /dwb on and /dwb off stop and start it.",
        docs: "https://github.com/mauajsi/Dynamic-World-Border",
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
 *
 * Required, for the same reason a blueprint's own plugins are: a server created
 * as "Both" whose Geyser quietly did not install is a Java server, and the person
 * who finds that out is a Bedrock player who cannot connect to it.
 */
export const CROSSPLAY_PROJECTS = ["geyser", "floodgate"] as const;

/** Everything a server built from this blueprint has to be able to install, which
 *  is what the release it runs on is pinned against. */
export function requiredProjects(blueprint: GameBlueprint, crossplay: boolean): string[] {
    return [...blueprint.projects, ...(crossplay ? CROSSPLAY_PROJECTS : [])];
}

/**
 * Whether a plugin list is the one that lets Bedrock clients in.
 *
 * Read off the list rather than recorded anywhere, because the list is what the
 * container actually installs - and it is Geyser being on it that decides, so a
 * server somebody added Geyser to by hand answers yes as well.
 */
export function hasCrossplay(projects: string | undefined): boolean {
    return (projects ?? "")
        .split(/[,\n]/)
        .some((entry) => projectSlug(entry)?.toLowerCase() === CROSSPLAY_PROJECTS[0]);
}

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
