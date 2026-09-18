/**
 * The games Polaris knows how to run a server of.
 *
 * The marketplace already describes each app; what it cannot say is which apps
 * belong to the same game. A game is the manifests its servers are actually
 * created from - Minecraft is two, ARK and FiveM one each - and every screen that has to
 * reason about "which game is this" was reading a catalog id and guessing. This
 * is that answer in one place.
 *
 * There is one app for all of them, not one per game: `game-servers` turns the
 * page on, and a game's own runtime is installed the first time a server of it is
 * created. Each game still names the app it used to have, because instances that
 * installed one still have that row until it is migrated.
 *
 * Pure, and deliberately free of anything a browser cannot run: the create dialog
 * offers these, the server side dispatches on them, and the two must not be able
 * to disagree about what games exist.
 */

/** The one marketplace app every game is created from. */
export const GAME_SERVERS_APP_ID = "game-servers";

/** The games a server can be created for. */
export type GameId = "minecraft" | "ark" | "fivem";

export interface GameDefinition {
    readonly id: GameId;
    readonly name: string;
    /** One line, for the picker that asks which game this server plays. */
    readonly summary: string;
    /** What it takes to run one, since these differ by an order of magnitude and
     *  the difference is the whole reason a create fails an hour later. */
    readonly demands: string;
    /**
     * The game's own mark, served from `public/logos`. A name in a list is read;
     * a logo is recognised.
     *
     * Each is the publisher's own artwork rather than something drawn here:
     * Minecraft's is the grass block out of the vendored texture set
     * (`resources/mcicons`), ARK's is the emblem from its Steam store logo with
     * the wordmark cropped off - the words under it are pale grey and vanish on a
     * light background at this size, and FiveM's is its own single-colour mark.
     */
    readonly logo: string;
    /** The per-game manager app this game used to be installed as, before there
     *  was one app for all of them. Only for recognising the installs that still
     *  carry it; nothing new is ever created under it. Absent for a game that
     *  arrived after there was one app, which never had a manager of its own. */
    readonly legacyManagerCatalogId?: string;
    /** Every manifest a server of this game is created from. */
    readonly serverCatalogIds: readonly string[];
    /** The label its servers' names live under, so two games' servers can never
     *  collide on one subdomain: `survival.mc.example.com`, `island.ark.example.com`. */
    readonly domainLabel: string;
    /** Whether a client finds the port by itself once the name resolves. Only
     *  Minecraft: Java clients look up a SRV record, everything else is told the
     *  port as part of the address. */
    readonly srv: boolean;
}

export const GAMES: readonly GameDefinition[] = [
    {
        id: "minecraft",
        name: "Minecraft",
        summary: "Java for PC, Bedrock for phones and consoles, or one world both can join.",
        demands: "About 2 GB of memory and a gigabyte of disk.",
        logo: "/logos/minecraft.webp",
        legacyManagerCatalogId: "minecraft-manager",
        serverCatalogIds: ["minecraft", "minecraft-bedrock"],
        domainLabel: "mc",
        srv: true
    },
    {
        id: "ark",
        name: "ARK: Survival Evolved",
        summary: "A dinosaur survival island for PC players, on the map you choose.",
        demands: "About 8 GB of memory and 30 GB of disk, downloaded on the first start.",
        logo: "/logos/ark.webp",
        legacyManagerCatalogId: "ark-manager",
        serverCatalogIds: ["ark"],
        domainLabel: "ark",
        srv: false
    },
    {
        id: "fivem",
        name: "FiveM",
        summary: "Grand Theft Auto V on a server of your own, running the resources you choose.",
        demands: "About 2 GB of memory and 3 GB of disk, plus whatever your resources weigh.",
        logo: "/logos/fivem.svg",
        serverCatalogIds: ["fivem"],
        domainLabel: "gta",
        srv: false
    }
];

export function findGame(id: string): GameDefinition | undefined {
    return GAMES.find((game) => game.id === id);
}

/** Which game a catalog id belongs to - a server's, or the per-game manager it may
 *  still be installed as - and null for an app that is not part of one. The one
 *  app all of them are created from belongs to no single game; ask
 *  `isGameServersApp` for that. */
export function gameForCatalogId(catalogId: string): GameDefinition | undefined {
    return GAMES.find(
        (game) => game.legacyManagerCatalogId === catalogId || game.serverCatalogIds.includes(catalogId)
    );
}

/** Which game a server runs. Null for an install that is not a game server, so a
 *  caller that has to dispatch cannot quietly land on a default. */
export function gameOfServer(catalogId: string): GameDefinition | null {
    return GAMES.find((game) => game.serverCatalogIds.includes(catalogId)) ?? null;
}

/** Whether a catalog id is the one app every game is created from. */
export function isGameServersApp(catalogId: string): boolean {
    return catalogId === GAME_SERVERS_APP_ID;
}

/** Whether a catalog id turns the Game servers page on - the one app, or one of
 *  the per-game managers that used to. */
export function isGameManagerApp(catalogId: string): boolean {
    return isGameServersApp(catalogId) || GAMES.some((game) => game.legacyManagerCatalogId === catalogId);
}

/**
 * The edition whose clients speak UDP, and so carry no hostname in the connection.
 *
 * It sits inside the Minecraft game rather than beside it, which is exactly why this
 * has to be named: the game says its clients look a name up, and for this one manifest
 * that is not true. Read `routesByHostname` rather than this.
 */
const BEDROCK_CATALOG_ID = "minecraft-bedrock";

/**
 * Whether a client of this server tells the server which address it dialled.
 *
 * Minecraft: Java puts it in the handshake packet, before login and in the clear,
 * which is what lets one port serve many servers by name and what lets a SRV record
 * move the port out of the address. Bedrock and ARK are UDP and do neither, so their
 * address carries its port.
 *
 * One predicate for both, because they are the same fact: whichever way the port is
 * kept out of what a player types, it needs the client to name the address first.
 */
export function routesByHostname(catalogId: string): boolean {
    return Boolean(gameOfServer(catalogId)?.srv) && catalogId !== BEDROCK_CATALOG_ID;
}
