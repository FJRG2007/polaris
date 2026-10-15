/**
 * The rest of the servers from the list, opened: The Island (ARK) and Roleplay
 * City (FiveM), plus what every server's Settings screen reads.
 */

import { ago } from "./people";
import { survivalContext } from "./game-server";
import { gameFacts, gameServers } from "./games";
import type { SceneContext } from "../runtime/scene";
import { translatorFor } from "@/lib/i18n/translate";
import { localizeSetting } from "@/lib/apps/app-words";
import type { AppSlot } from "@/lib/app-extensions/types";
import { findApp, tunableEnvVars } from "@/lib/apps/catalog";
import skinTexture from "../../../resources/default-skins/slim/ari.png";
import { NO_SCHEDULE } from "../../../apps/game-servers/src/lib/minecraft/schedule";
import type { InstalledAppDetail, InstalledAppSetting } from "@/lib/apps/install-service";
import type { GameContext } from "../../../apps/game-servers/src/screens/installed/game-context";
import { DEFAULT_HALLOWEEN } from "../../../apps/game-servers/src/lib/minecraft/seasonal-halloween";
import { WINTER_DEFAULTS } from "../../../apps/game-servers/src/lib/minecraft/seasonal-winter";

/** Where ARK and FiveM sit in the list (`fixtures/games.ts`). */
export const ARK_INDEX = 2;
export const FIVEM_INDEX = 3;

/** The install row the page is handed for the server at `index` in the list. */
export function installedApp(ctx: SceneContext, index: number): InstalledAppDetail {
    const seed = gameServers(ctx)[index]!;
    return {
        id: seed.id,
        catalogId: seed.catalogId,
        name: seed.name,
        status: "installed",
        applicationId: seed.applicationId,
        targetId: null,
        createdAt: ago(ctx.now, 60 * 24 * (40 - index * 7)),
        ownerId: "",
        catalogName: seed.catalogName,
        dashboardKind: "app",
        applicationStatus: seed.status === "running" ? "running" : "stopped",
        serverName: "Local"
    };
}

/**
 * A game's settings the way the settings read hands them over: every tunable
 * variable of its manifest, in manifest order and in the reader's language,
 * holding the manifest default unless `values` says what it was deployed with.
 */
function gameSettings(
    ctx: SceneContext,
    catalogId: string,
    values: Record<string, string>
): InstalledAppSetting[] {
    const manifest = findApp(catalogId);
    if (!manifest) throw new Error(`no ${catalogId} in the catalog`);
    const words = translatorFor(ctx.locale, "catalog");
    return tunableEnvVars(manifest).map((field) =>
        localizeSetting(words, manifest.id, {
            key: field.key,
            label: field.label,
            ...(field.help ? { help: field.help } : {}),
            ...(field.group ? { group: field.group } : {}),
            value: values[field.key] ?? field.default ?? "",
            ...(field.options ? { options: [...field.options] } : {})
        })
    );
}

/** What Survival was deployed with: Paper on a pinned release, a roomier heap. */
export function survivalSettings(ctx: SceneContext): InstalledAppSetting[] {
    return gameSettings(ctx, "minecraft", {
        TYPE: "PAPER",
        VERSION: "1.21.4",
        MEMORY: "6G",
        MOTD: ctx.say("Survival - friends welcome", "Supervivencia - amigos bienvenidos"),
        DIFFICULTY: "normal",
        VIEW_DISTANCE: "12",
        SEED: "8675309"
    });
}

/** What The Island was deployed with. */
export function arkSettings(ctx: SceneContext): InstalledAppSetting[] {
    return gameSettings(ctx, "ark", { SESSION_NAME: "The Island" });
}

/** What the page knows about a server before it asks it anything. */
function contextFor(ctx: SceneContext, index: number, game: Partial<GameContext>): GameContext {
    const address = gameFacts(ctx)[index]!.address;
    const hostname = address.replace(/:\d+$/, "");
    return {
        ...survivalContext(ctx),
        hostname,
        suffix: hostname.split(".").slice(1).join("."),
        address,
        edition: null,
        schedule: NO_SCHEDULE,
        playerAccess: null,
        ...game
    };
}

/** The panel Game servers draws on a server's page, given what it knows. */
export function gameSlot(context: GameContext): AppSlot {
    return {
        app: "game-servers",
        kind: "server",
        props: { context },
        bundle: { src: "readme-media:game-servers", name: "GameServersSlot" }
    };
}

export function arkSlot(ctx: SceneContext): AppSlot {
    return gameSlot(contextFor(ctx, ARK_INDEX, { gamePort: 7777, queryPort: 27015 }));
}

export function fivemSlot(ctx: SceneContext): AppSlot {
    return gameSlot(contextFor(ctx, FIVEM_INDEX, { gamePort: 30120, fivemAccess: fivemAccess() }));
}

/** Survivors on The Island, with made-up SteamIDs. */
const ARK_PLAYERS = [
    { name: "Rex Tamer", steamId: "76561190000000101" },
    { name: "Doedicurus", steamId: "76561190000000102" },
    { name: "Kenji", steamId: "76561190000000103" },
    { name: "Sam", steamId: "76561190000000104" }
];

/** What The Island says on every poll. */
export function arkReading(ctx: SceneContext) {
    const facts = gameFacts(ctx)[ARK_INDEX]!;
    return {
        status: {
            answering: true,
            containerRunning: true,
            players: ARK_PLAYERS,
            message: null,
            crashLoop: null,
            running: true,
            max: facts.slots,
            gamePort: 7777,
            queryPort: 27015,
            cpuPercent: 54,
            memUsedBytes: 9.4 * 1024 ** 3,
            memTotalBytes: 16 * 1024 ** 3
        },
        address: facts.address,
        reach: null,
        access: { closed: false, logging: true, players: [], accounts: {} },
        timeouts: [],
        admins: [],
        profiles: {},
        seen: {}
    };
}

/** Who may join Roleplay City: nobody listed yet, the door open. */
function fivemAccess() {
    return { allowList: [], bans: [], admins: [], exclusiveJoin: false, handedOver: true };
}

/** What Roleplay City says while it is stopped. */
export function fivemReading(ctx: SceneContext) {
    const facts = gameFacts(ctx)[FIVEM_INDEX]!;
    return {
        status: {
            answering: false,
            containerRunning: false,
            players: [],
            max: 0,
            message: null,
            crashLoop: null,
            running: false,
            port: 30120,
            hostname: null,
            build: null,
            resourcesRunning: null,
            guardRunning: null,
            cpuPercent: null,
            memUsedBytes: null,
            memTotalBytes: null
        },
        address: facts.address,
        reach: null,
        access: fivemAccess(),
        seen: {}
    };
}

/** Where a server's files are kept: on this machine, with one NAS to move to. */
export function gameStorage() {
    return {
        places: [null],
        choice: null,
        locked: false,
        outOfReach: false,
        connections: [{ id: "nas-1", name: "Home NAS" }],
        parkable: true,
        blocked: null,
        running: true,
        move: null,
        sizeBytes: 3.8 * 1024 ** 3
    };
}

/** Survival's seasonal decorations: on, out of season. */
export function survivalSeasonal() {
    return {
        view: {
            on: true,
            showing: null,
            season: null,
            blocked: false,
            paused: false,
            needsRestart: false,
            unavailable: false,
            nightSpawns: 1,
            snowGolems: 1,
            mobsNeedRestart: false,
            halloween: DEFAULT_HALLOWEEN,
            halloweenNeedsRestart: false,
            winter: WINTER_DEFAULTS,
            winterNeedsRestart: false
        }
    };
}

/** What one player wears as the server reads it: a slim skin, signed. */
export function survivalSkin() {
    return {
        live: { state: "read", skin: { hash: "fixture-skin", model: "slim", signed: true } },
        uuid: "00000000-0000-4000-8000-00000000a7a1",
        ownSkin: false
    };
}

/** The texture behind that skin: one of the game's own defaults, as base64 -
 *  the bundler inlines the file as a data URL, so reading it needs no fetch. */
export const SKIN_TEXTURE = skinTexture.slice(skinTexture.indexOf(",") + 1);
