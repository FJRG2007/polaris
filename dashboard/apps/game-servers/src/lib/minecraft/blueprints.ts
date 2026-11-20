/**
 * Blueprints: a server that is already something when it starts.
 *
 * A blueprint is a named preset over the same settings the create dialog holds -
 * the software, the world properties, and the plugins the image installs on its
 * first boot. Every plugin named here is a real Modrinth project the image
 * fetches itself; nothing about a blueprint is content Polaris ships.
 *
 * The world a blueprint plays on is a separate decision, and `mapCategory` is
 * where the two meet: a blueprint that names one can be built on a prebuilt map
 * of that kind instead of a generated world - see `maps.ts` for what that
 * changes, which is most of what the blueprint decided.
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

import { gameMessage } from "../game-message";
import { projectSlug } from "./modrinth";
import { FLAT_LEVEL_TYPE } from "./world";
import { VOID_GENERATOR_SETTINGS } from "./oneblock";
import { pinnedRelease } from "./maps";
import type { MapCategory, WorldMap } from "./maps";

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
    /** The one value that software asks for - the modpack - when the blueprint
     *  settles it itself, so the operator is never asked to name one. */
    readonly softwareSource?: string;
    /**
     * The one release it runs on, for a game whose content decides it rather than
     * a plugin list: a modpack is built for one release and its loader, and a
     * server asked for any other is a pack that does not resolve.
     */
    readonly release?: string;
    /**
     * Kept so the servers already built from it still read and reset, and no
     * longer offered for a new one - because something better now does its job.
     */
    readonly retired?: boolean;
    /**
     * What every player has to install before they can join, with where to get
     * it. A modded game is one the vanilla client cannot even connect to.
     */
    readonly clientPack?: { readonly name: string; readonly url: string };
    /** Modrinth projects installed on the first boot, on top of the defaults. */
    readonly projects: readonly string[];
    /**
     * SpigotMC resource numbers its plugins cannot run without.
     *
     * Modrinth installs a project's Modrinth dependencies and can do nothing
     * about the rest, and several of the best known server libraries - Vault
     * above all - have only ever been published on SpigotMC. A plugin whose
     * dependency is missing is not a plugin that works badly: the server refuses
     * to load it, comes up without it, and says so only in a log.
     */
    readonly spigot?: readonly number[];
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
    /** The kind of prebuilt map this game can be built on, when there is one. */
    readonly mapCategory?: MapCategory;
    readonly weight: BlueprintWeight;
}

/**
 * Lucky Block Challenge (Kesselot), the modpack its blueprints install: NeoForge
 * on 1.21.1 with Modern Lucky Block and Architectury, and four prebuilt worlds.
 *
 * Pinned to one version page, which the image resolves to that exact pack (and
 * through it the loader and the release). The image applies the pack's overrides
 * to /data - its worlds land in /data/saves, where a client would keep them - and
 * runs its world step right after, so `WORLD` naming one of those folders copies
 * it into the level the first time that level does not exist (itzg
 * docker-minecraft-server, scripts/start-deployModrinth and start-setupWorld).
 */
export const LUCKY_CHALLENGE = {
    pack: "https://modrinth.com/modpack/lucky-block-challenge/version/2.1.2",
    page: "https://modrinth.com/modpack/lucky-block-challenge",
    release: "1.21.1",
    /** Where the pack's overrides put its worlds inside the container. */
    saves: "/data/saves"
} as const;

/**
 * Where a CurseForge file is downloaded from without an API key.
 *
 * CurseForge's documented API (api.curseforge.com) refuses every request without
 * a key from its studio console, and a project's download page answers machines
 * with a browser challenge. This is the address the website's own Download
 * button calls: it answers with a redirect to the file on CurseForge's CDN,
 * which the image follows. Undocumented, so it is one function a test pins and
 * one place to change.
 */
export function curseforgeFileUrl(project: number, file: number): string {
    return `https://www.curseforge.com/api/v1/mods/${project}/files/${file}/download`;
}

/** One of the pack's worlds as a blueprint of its own. `world` is the folder
 *  name after "Lucky Block Challenge ", as the pack ships it. */
function luckyChallenge(
    id:
        | "lucky-challenge-race"
        | "lucky-challenge-pillars"
        | "lucky-challenge-oneblock"
        | "lucky-challenge-games",
    world: string
): GameBlueprint {
    return {
        id,
        name: gameMessage("games", `lib.blueprints.${id}.name`),
        summary: gameMessage("games", `lib.blueprints.${id}.summary`),
        editions: ["java"],
        software: "MODRINTH",
        softwareSource: LUCKY_CHALLENGE.pack,
        release: LUCKY_CHALLENGE.release,
        // The pack carries every mod; nothing is added on top of it.
        projects: [],
        env: {
            LEVEL: id,
            WORLD: `${LUCKY_CHALLENGE.saves}/Lucky Block Challenge ${world}`,
            PVP: "true",
            SPAWN_PROTECTION: "0",
            ALLOW_FLIGHT: "true"
        },
        setup: gameMessage("games", "lib.blueprints.lucky-challenge.setup"),
        docs: LUCKY_CHALLENGE.page,
        clientPack: { name: "Lucky Block Challenge 2.1.2", url: LUCKY_CHALLENGE.page },
        weight: "heavy"
    };
}

export const GAME_BLUEPRINTS: readonly GameBlueprint[] = [
    {
        id: "survival",
        name: gameMessage("games", "lib.blueprints.survival.name"),
        summary: gameMessage("games", "lib.blueprints.survival.summary"),
        editions: ["java", "bedrock"],
        projects: [],
        weight: "normal"
    },
    {
        id: "creative",
        name: gameMessage("games", "lib.blueprints.creative.name"),
        summary: gameMessage("games", "lib.blueprints.creative.summary"),
        editions: ["java", "bedrock"],
        projects: [],
        env: { MODE: "creative", DIFFICULTY: "peaceful", GAMEMODE: "creative" },
        weight: "light"
    },
    {
        id: "skyblock",
        name: gameMessage("games", "lib.blueprints.skyblock.name"),
        summary: gameMessage("games", "lib.blueprints.skyblock.summary"),
        editions: ["java"],
        software: "PAPER",
        projects: ["iridiumskyblock"],
        // Vault, which IridiumSkyblock declares as a hard dependency and which
        // exists only on SpigotMC. Without it the server loads everything else,
        // reaches "Done", and has no skyblock in it at all.
        spigot: [34315],
        // The islands are worlds the plugin makes and manages itself; what the
        // server generates is only where people land before they have one.
        levelType: FLAT_LEVEL_TYPE,
        setup: gameMessage("games", "lib.blueprints.skyblock.setup"),
        docs: "https://docs.iridiumdevelopment.net/",
        mapCategory: "skyblock",
        weight: "normal"
    },
    {
        id: "oneblock",
        name: gameMessage("games", "lib.blueprints.oneblock.name"),
        summary: gameMessage("games", "lib.blueprints.oneblock.summary"),
        editions: ["java"],
        software: "PAPER",
        projects: ["oneblock_bukkit"],
        // The plugin is told where the first block goes by Polaris itself, on the
        // first pass after it loads (see `oneblock.ts`); this is only the world it
        // floats in. Void rather than plain flat, so the island is the only ground.
        levelType: FLAT_LEVEL_TYPE,
        env: { GENERATOR_SETTINGS: VOID_GENERATOR_SETTINGS },
        setup: gameMessage("games", "lib.blueprints.oneblock.setup"),
        docs: "https://github.com/MrMarL/OneBlock",
        weight: "light"
    },
    {
        id: "oneblock-classic",
        name: gameMessage("games", "lib.blueprints.oneblock-classic.name"),
        summary: gameMessage("games", "lib.blueprints.oneblock-classic.summary"),
        editions: ["java"],
        software: "PAPER",
        projects: ["oneblock_bukkit"],
        // The same plugin and void as OneBlock; what changes is the ladder the
        // block climbs, which Polaris writes over the plugin's own levels once it
        // has loaded (see `oneblock-phases.ts`).
        levelType: FLAT_LEVEL_TYPE,
        env: { GENERATOR_SETTINGS: VOID_GENERATOR_SETTINGS },
        setup: gameMessage("games", "lib.blueprints.oneblock-classic.setup"),
        docs: "https://github.com/MrMarL/OneBlock",
        weight: "light"
    },
    {
        id: "parkour",
        name: gameMessage("games", "lib.blueprints.parkour.name"),
        summary: gameMessage("games", "lib.blueprints.parkour.summary"),
        editions: ["java"],
        software: "PAPER",
        projects: ["infiniteparkour"],
        env: { MODE: "adventure", DIFFICULTY: "peaceful", PVP: "false" },
        levelType: FLAT_LEVEL_TYPE,
        setup: gameMessage("games", "lib.blueprints.parkour.setup"),
        docs: "https://efnilite.dev/projects/ip/wiki",
        mapCategory: "parkour",
        weight: "light"
    },
    {
        id: "bedwars",
        name: gameMessage("games", "lib.blueprints.bedwars.name"),
        summary: gameMessage("games", "lib.blueprints.bedwars.summary"),
        editions: ["java"],
        software: "PAPER",
        // BedWars1058's finished releases stop at 1.20.4; everything from 1.21 on
        // is published as a snapshot, so a server built on a modern release has to
        // be willing to take one. Said here rather than left to the image's
        // default, which takes finished releases only and refused the jar - the
        // container then restarted forever on an error nobody was shown.
        projects: ["bedwars1058:beta"],
        levelType: FLAT_LEVEL_TYPE,
        // The one blueprint whose game does not exist until somebody makes it. Said
        // plainly, because a server that looks like an empty world is exactly what
        // BedWars1058 with no arena is - not a failed install.
        setup: gameMessage("games", "lib.blueprints.bedwars.setup"),
        docs: "https://wiki.andrei1058.com/docs/BedWars1058/addons",
        mapCategory: "bedwars",
        weight: "heavy"
    },
    {
        id: "luckyblock",
        name: gameMessage("games", "lib.blueprints.luckyblock.name"),
        summary: gameMessage("games", "lib.blueprints.luckyblock.summary"),
        editions: ["java"],
        software: "PAPER",
        // Lucky Blocks by lullaby6 is a datapack, not a plugin: the block is a hay
        // bale wearing a display entity, so it looks the part with no resource
        // pack and no client mod, and breaking one rolls an item, a block, a chest
        // of loot, a trap, a mob or a weapon kit. The world add-on scatters them
        // through the overworld as a structure, which is why the world is an
        // ordinary survival one rather than a flat lobby - and why the add-on has
        // to be in place before the world is generated, which the image sees to.
        // A "datapack:" entry is downloaded from Modrinth at every boot into the
        // level's datapacks folder, the same as a plugin into plugins; nothing of
        // either pack (AGPL / LGPL) is shipped with Polaris. The add-on declares
        // no dependency on Modrinth, so both are named.
        projects: ["datapack:ly-lucky-blocks", "datapack:lucky-blocks-world"],
        env: { MODE: "survival", PVP: "true" },
        setup: gameMessage("games", "lib.blueprints.luckyblock.setup"),
        docs: "https://modrinth.com/datapack/ly-lucky-blocks",
        mapCategory: "luckyblock",
        // An imitation of the Lucky Block mod - a hay bale wearing a display
        // entity - which the Lucky Block Challenge blueprints below replace with
        // the real mod. Kept for the servers already built on it.
        retired: true,
        weight: "normal"
    },
    {
        id: "luckyrace",
        name: gameMessage("games", "lib.blueprints.luckyrace.name"),
        summary: gameMessage("games", "lib.blueprints.luckyrace.summary"),
        editions: ["java"],
        software: "PAPER",
        // The same Lucky Blocks pack, without the add-on that scatters them
        // through a generated world: the course is the only ground, built and
        // refereed by a pack Polaris writes once the server is up (see
        // `lucky-race.ts`). The lobby is adventure so nothing in it can be
        // broken; the lanes switch each racer to survival.
        projects: ["datapack:ly-lucky-blocks"],
        levelType: FLAT_LEVEL_TYPE,
        env: {
            GENERATOR_SETTINGS: VOID_GENERATOR_SETTINGS,
            MODE: "adventure",
            DIFFICULTY: "normal",
            PVP: "true",
            SPAWN_PROTECTION: "0"
        },
        setup: gameMessage("games", "lib.blueprints.luckyrace.setup"),
        docs: "https://modrinth.com/datapack/ly-lucky-blocks",
        // Replaced by the race map of Lucky Block Challenge on the real mod.
        retired: true,
        weight: "light"
    },
    luckyChallenge("lucky-challenge-race", "Race"),
    luckyChallenge("lucky-challenge-pillars", "Lucky Pillars"),
    luckyChallenge("lucky-challenge-oneblock", "OneBlock"),
    luckyChallenge("lucky-challenge-games", "Games"),
    {
        id: "lucky-oneblock",
        name: gameMessage("games", "lib.blueprints.lucky-oneblock.name"),
        summary: gameMessage("games", "lib.blueprints.lucky-oneblock.summary"),
        editions: ["java"],
        // Lucky OneBlock 26.2 (v1.1) by el_this_boy: a Fabric world whose own
        // datapack puts My Lucky Block's block back every time it is broken
        // (`myluckyblock:my_lucky_block`, read off its detect function). The mod
        // has to be on the server for that block to exist at all; Fabric API
        // comes with it as its dependency.
        software: "FABRIC",
        release: "26.2",
        projects: ["myluckyblock"],
        env: {
            LEVEL: "lucky-oneblock",
            WORLD: curseforgeFileUrl(872580, 8550497),
            // The one block is at spawn; protection would make it unbreakable.
            SPAWN_PROTECTION: "0"
        },
        setup: gameMessage("games", "lib.blueprints.lucky-oneblock.setup"),
        docs: "https://www.curseforge.com/minecraft/worlds/lucky-oneblock",
        clientPack: { name: "MyLuckyBlock (Fabric 26.2)", url: "https://modrinth.com/mod/myluckyblock" },
        weight: "normal"
    },
    {
        id: "lucky-race-manoj",
        name: gameMessage("games", "lib.blueprints.lucky-race-manoj.name"),
        summary: gameMessage("games", "lib.blueprints.lucky-race-manoj.summary"),
        editions: ["java"],
        // ManojTheReaper's race: lanes, then PvP. Its lucky blocks are the Lucky
        // Blocks datapack (v1.3.3, for 1.21-1.21.1) inside the world's own
        // datapacks folder, and its level.dat is 1.21.1 - so no mod on either side,
        // and the release that datapack was written for.
        software: "PAPER",
        release: "1.21.1",
        projects: [],
        env: {
            LEVEL: "lucky-race-manoj",
            WORLD: curseforgeFileUrl(1574864, 8245381),
            PVP: "true",
            SPAWN_PROTECTION: "0"
        },
        setup: gameMessage("games", "lib.blueprints.lucky-race-manoj.setup"),
        docs: "https://www.curseforge.com/minecraft/worlds/lucky-block-race-by-manojthereaper",
        weight: "normal"
    },
    {
        id: "shrinking-world",
        name: gameMessage("games", "lib.blueprints.shrinking-world.name"),
        summary: gameMessage("games", "lib.blueprints.shrinking-world.summary"),
        editions: ["java"],
        software: "PAPER",
        projects: ["dynamicworldborder"],
        setup: gameMessage("games", "lib.blueprints.shrinking-world.setup"),
        docs: "https://github.com/mauajsi/Dynamic-World-Border",
        weight: "normal"
    }
];

export function findBlueprint(id: string): GameBlueprint | undefined {
    return GAME_BLUEPRINTS.find((blueprint) => blueprint.id === id);
}

/** Blueprints that can be created for an edition. A retired one is not offered,
 *  and still found by `findBlueprint` for the servers built from it. */
export function blueprintsFor(edition: "java" | "bedrock"): readonly GameBlueprint[] {
    return GAME_BLUEPRINTS.filter(
        (blueprint) => !blueprint.retired && blueprint.editions.includes(edition)
    );
}

/** The release a server of this blueprint, on this map, has to run on - the map's
 *  pin first, because it is what people stand in - or null when nothing pins it. */
export function releaseFor(
    blueprint: GameBlueprint | undefined,
    map: WorldMap | undefined
): string | null {
    return pinnedRelease(map) ?? blueprint?.release ?? null;
}

/**
 * The plugin that lets Bedrock clients join a Java server.
 *
 * Geyser translates the protocol, and it is required for the same reason a
 * blueprint's own plugins are: a server created as "Both" whose Geyser quietly
 * did not install is a Java server, and the person who finds that out is a
 * Bedrock player who cannot connect to it. GeyserMC publishes it as a rolling
 * build rather than as tagged releases, so the entry says which builds count.
 *
 * Floodgate is deliberately not here. It is the half that lets a Bedrock player
 * in without a Java account, and GeyserMC publishes no Paper build of it on
 * Modrinth at all - the project there carries Fabric and NeoForge only. Naming it
 * anyway asked the image for something that does not exist, which was harmless
 * while these entries were optional and is a server that will not start now they
 * are not. Bedrock players still join; they need a Java account to do it.
 */
export const CROSSPLAY_PROJECTS = ["geyser:beta"] as const;

/**
 * Everything a server built from this blueprint has to be able to install, which
 * is what the release it runs on is pinned against.
 *
 * `instead` is a map's own plugin list, which replaces the blueprint's rather than
 * adding to it - a map that carries its own game does not want the plugin that
 * exists to provide one. The crossplay pair is not a game and stays either way.
 */
export function requiredProjects(
    blueprint: GameBlueprint,
    crossplay: boolean,
    instead?: readonly string[]
): string[] {
    return [...(instead ?? blueprint.projects), ...(crossplay ? CROSSPLAY_PROJECTS : [])];
}

/**
 * Whether a plugin list is the one that lets Bedrock clients in.
 *
 * Read off the list rather than recorded anywhere, because the list is what the
 * container actually installs - and it is Geyser being on it that decides, so a
 * server somebody added Geyser to by hand answers yes as well.
 */
export function hasCrossplay(projects: string | undefined): boolean {
    // Both sides through the same parser: the entry carries a release type, and
    // comparing the raw strings would stop matching the day one is added to it.
    const geyser = projectSlug(CROSSPLAY_PROJECTS[0])?.toLowerCase();
    return (projects ?? "")
        .split(/[,\n]/)
        .some((entry) => projectSlug(entry)?.toLowerCase() === geyser);
}

/** The same figure as the image wants it ("2G", "2560M"). */
export function formatMemory(megabytes: number): string {
    return megabytes % 1024 === 0 ? `${megabytes / 1024}G` : `${megabytes}M`;
}
