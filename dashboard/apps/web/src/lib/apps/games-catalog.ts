/**
 * The games Polaris knows how to run a server of.
 *
 * The marketplace already describes each app; what it cannot say is which apps
 * belong to the same game. A game is a manager somebody installs once and the
 * manifests its servers are actually created from - Minecraft is three ids, ARK
 * is two - and every screen that has to reason about "which game is this" was
 * reading a catalog id and guessing. This is that answer in one place.
 *
 * Pure, and deliberately free of anything a browser cannot run: the create dialog
 * offers these, the server side dispatches on them, and the two must not be able
 * to disagree about what games exist.
 */

/** The games a server can be created for. */
export type GameId = "minecraft" | "ark";

export interface GameDefinition {
    readonly id: GameId;
    readonly name: string;
    /** One line, for the picker that asks which game this server plays. */
    readonly summary: string;
    /** What it takes to run one, since these differ by an order of magnitude and
     *  the difference is the whole reason a create fails an hour later. */
    readonly demands: string;
    /** The marketplace app that turns this game on. Installing it runs nothing;
     *  it records that this Polaris can create servers of this game. */
    readonly managerCatalogId: string;
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
        managerCatalogId: "minecraft-manager",
        serverCatalogIds: ["minecraft", "minecraft-bedrock"],
        domainLabel: "mc",
        srv: true
    },
    {
        id: "ark",
        name: "ARK: Survival Evolved",
        summary: "A dinosaur survival island for PC players, on the map you choose.",
        demands: "About 8 GB of memory and 30 GB of disk, downloaded on the first start.",
        managerCatalogId: "ark-manager",
        serverCatalogIds: ["ark"],
        domainLabel: "ark",
        srv: false
    }
];

export function findGame(id: string): GameDefinition | undefined {
    return GAMES.find((game) => game.id === id);
}

/** Which game a catalog id belongs to - a server's or its manager's - and null for
 *  an app that is not part of one. */
export function gameForCatalogId(catalogId: string): GameDefinition | undefined {
    return GAMES.find((game) => game.managerCatalogId === catalogId || game.serverCatalogIds.includes(catalogId));
}

/** Which game a server runs. Null for an install that is not a game server, so a
 *  caller that has to dispatch cannot quietly land on a default. */
export function gameOfServer(catalogId: string): GameDefinition | null {
    return GAMES.find((game) => game.serverCatalogIds.includes(catalogId)) ?? null;
}

/** Whether a catalog id is the app that turns a game on. */
export function isGameManagerApp(catalogId: string): boolean {
    return GAMES.some((game) => game.managerCatalogId === catalogId);
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
