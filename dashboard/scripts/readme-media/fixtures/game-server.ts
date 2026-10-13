/** One Minecraft server opened from the list: the Survival world, seven playing. */

import { VIEWER, ago } from "./people";
import type { Permission } from "@polaris/core";
import type { SceneContext } from "../runtime/scene";
import type { AppSlot } from "@/lib/app-extensions/types";
import { gameFacts, gameLive, gameServers } from "./games";
import type { InstalledAppDetail, InstalledAppSetting } from "@/lib/apps/install-service";
import { defaultEventsConfig } from "../../../apps/game-servers/src/lib/minecraft/events/catalog";
import { NO_SCHEDULE } from "../../../apps/game-servers/src/lib/minecraft/schedule";
import type { GameContext } from "../../../apps/game-servers/src/screens/installed/game-context";

/** Everything a server's owner holds on it, so every tab is offered. */
export const SERVER_GRANTS: readonly Permission[] = [
    "games.read",
    "games.console",
    "games.manage",
    "games.moderate"
];

/** The Survival server from the list. */
export function survival(ctx: SceneContext) {
    const seed = gameServers(ctx)[0]!;
    const facts = gameFacts(ctx)[0]!;
    const live = gameLive(ctx)[0]!;
    return { seed, facts, live };
}

export function survivalApp(ctx: SceneContext): InstalledAppDetail {
    const { seed } = survival(ctx);
    return {
        id: seed.id,
        catalogId: seed.catalogId,
        name: seed.name,
        status: "installed",
        applicationId: seed.applicationId,
        targetId: null,
        createdAt: ago(ctx.now, 60 * 24 * 40),
        ownerId: "",
        catalogName: seed.catalogName,
        dashboardKind: "app",
        applicationStatus: "running",
        serverName: "Local"
    };
}

export const SURVIVAL_SETTINGS: InstalledAppSetting[] = [];

export function survivalContext(ctx: SceneContext): GameContext {
    const { facts } = survival(ctx);
    return {
        hostname: facts.address,
        suffix: "mc.example.com",
        address: facts.address,
        routed: true,
        canRoute: true,
        iconSetAt: null,
        edition: "java",
        blueprintId: null,
        mapId: null,
        schedule: NO_SCHEDULE,
        scheduleState: { checkedAt: null, emptySince: null, wokenAt: null },
        wakeOnJoin: false,
        routineRuns: {},
        arkAccess: null,
        playerAccess: survivalAccess(ctx),
        fivemAccess: null,
        gamePort: null,
        queryPort: null,
        rosterMemory: null,
        lastLevels: {},
        login: null,
        clientMods: [],
        packCommands: null,
        modsAwaitRestart: false
    };
}

export function survivalSlot(ctx: SceneContext): AppSlot {
    return {
        app: "game-servers",
        kind: "server",
        props: { context: survivalContext(ctx) },
        bundle: { src: "readme-media:game-servers", name: "GameServersSlot" }
    };
}

/** Who may join, and from where: every regular registered from one address
 *  (RFC 5737 documentation ranges), the server's owner tied to their account. */
export function survivalAccess(ctx: SceneContext) {
    const { live } = survival(ctx);
    return {
        rules: [...live.players, "Mateo_B"].map((username, index) => ({
            id: `rule-${index + 1}`,
            username,
            address: `198.51.100.${10 + index}`,
            note: null,
            createdAt: ago(ctx.now, 60 * 24 * (30 - index)),
            source: index % 3 === 0 ? ("manual" as const) : ("session" as const)
        })),
        refusals: [
            {
                player: "grief3r",
                address: "203.0.113.77",
                why: ctx.say("Not on the list", "No está en la lista"),
                at: ago(ctx.now, 95)
            }
        ],
        links: [{ username: "Alex", userId: VIEWER.id, name: VIEWER.name, followSignIns: true }],
        bindAddresses: true,
        addressesAvailable: true,
        edition: "java" as const
    };
}

/** What the server says on every poll. */
export function survivalReading(ctx: SceneContext) {
    const { facts, live } = survival(ctx);
    return {
        status: {
            edition: "java",
            running: true,
            containerRunning: true,
            answering: true,
            players: { online: live.online, max: live.max, players: live.players },
            address: facts.address,
            message: null,
            cpuPercent: 38,
            memUsedBytes: 3.1 * 1024 ** 3,
            memTotalBytes: 6 * 1024 ** 3,
            crashLoop: null
        },
        reach: null,
        roster: {
            ops: ["Alex", "nightowl"],
            whitelist: [...live.players, "Mateo_B", "skyler.j"],
            bans: [{ name: "grief3r", reason: "Griefing spawn", source: "Alex" }],
            whitelistEnforced: true
        },
        rosterAsOf: null,
        firewall: { blocked: [], applied: [], ranges: [] },
        access: survivalAccess(ctx),
        sessions: [],
        seen: Object.fromEntries(
            live.players.map((name, index) => {
                const since = ago(ctx.now, 12 + index * 23);
                return [`@${name.toLowerCase()}`, { since, lastSeen: null, open: since }];
            })
        ),
        timeouts: [],
        levels: Object.fromEntries(live.players.map((name, index) => [name, 34 - index * 4])),
        idle: {},
        lastLevels: {},
        pending: [],
        now: new Date(ctx.now).toISOString()
    };
}

/** What one regular carries: armour on, tools in the hotbar, a bag mid-build. */
export function survivalInventory(ctx: SceneContext) {
    const stack = (slot: number, name: string, count = 1) => ({
        slot,
        id: `minecraft:${name}`,
        count,
        data: null
    });
    return {
        reading: {
            items: [
                stack(0, "diamond_sword"),
                stack(1, "netherite_pickaxe"),
                stack(2, "bow"),
                stack(3, "torch", 48),
                stack(4, "cooked_beef", 22),
                stack(5, "water_bucket"),
                stack(6, "ender_pearl", 9),
                stack(7, "golden_apple", 3),
                stack(8, "oak_log", 64),
                stack(9, "arrow", 64),
                stack(10, "cobblestone", 64),
                stack(11, "cobblestone", 37),
                stack(13, "redstone", 30),
                stack(18, "bread", 12),
                stack(20, "firework_rocket", 24),
                stack(27, "oak_log", 18),
                stack(103, "diamond_helmet"),
                stack(102, "elytra"),
                stack(101, "iron_leggings"),
                stack(100, "diamond_boots"),
                stack(-106, "totem_of_undying")
            ],
            live: true,
            takenAt: new Date(ctx.now).toISOString()
        }
    };
}

/** Events set up on the server: a few run, one on now with its scoreboard. */
export function survivalEvents(ctx: SceneContext) {
    const config = defaultEventsConfig(ctx.locale === "es-ES" ? "es" : "en");
    const preset = (kind: string) => config.presets.find((one) => one.kind === kind)!;
    const mining = preset("mining-rush");
    const minute = 60_000;
    const ended = (
        index: number,
        kind: string,
        hoursAgo: number,
        podium: [string, number][],
        trigger: "manual" | "scheduled" | "random"
    ) => {
        const found = preset(kind);
        return {
            id: `history-${index}`,
            presetId: found.id,
            kind: found.kind,
            name: found.name,
            trigger,
            outcome: "finished" as const,
            note: "",
            startedAt: ctx.now - hoursAgo * 60 * minute,
            endedAt: ctx.now - hoursAgo * 60 * minute + 10 * minute,
            participants: podium.length + 2,
            podium: podium.map(([name, score], place) => ({ place: place + 1, name, score })),
            disqualified: [],
            delivered: [],
            search: null,
            keptOut: []
        };
    };
    return {
        view: {
            config,
            run: {
                presetId: mining.id,
                name: mining.name,
                kind: mining.kind,
                phase: "running" as const,
                startsAt: ctx.now - 4 * minute,
                endsAt: ctx.now + 6 * minute,
                trigger: "scheduled" as const,
                cancelling: false,
                standings: [
                    { name: "kenjimori", score: 41 },
                    { name: "Builder_Ana", score: 36 },
                    { name: "RedstoneRiv", score: 29 },
                    { name: "lena_f", score: 17 }
                ],
                takesForced: false,
                inEvent: [],
                forced: [],
                online: survival(ctx).live.players
            },
            history: [
                ended(1, "treasure-hunt", 5, [["PixelPriya", 3], ["nightowl", 2], ["Alex", 1]], "random"),
                ended(2, "parkour", 26, [["lena_f", 30], ["kenjimori", 27], ["Builder_Ana", 22]], "manual"),
                ended(3, "world-boss", 50, [["nightowl", 812], ["Alex", 640], ["RedstoneRiv", 455]], "scheduled")
            ],
            pending: [],
            stashFailures: [],
            arenaRemains: [],
            nextRandomAt: ctx.now + 95 * minute,
            waiting: null,
            drawCheckedAt: ctx.now - minute,
            lastRandom: { name: preset("treasure-hunt").name, startedAt: ctx.now - 5 * 60 * minute },
            players: { online: 7, active: 6 }
        }
    };
}

/** The last few minutes of the server's log, as the console shows it. */
export function survivalLog(ctx: SceneContext): string {
    const at = (minutesAgo: number) =>
        new Date(ctx.now - minutesAgo * 60_000).toISOString().slice(11, 19);
    return [
        [42, "[Server thread/INFO]: Done (8.214s)! For help, type \"help\""],
        [38, "[Server thread/INFO]: Alex joined the game"],
        [31, "[Server thread/INFO]: nightowl joined the game"],
        [24, "[Server thread/INFO]: <nightowl> anyone up for the end tonight?"],
        [19, "[Server thread/INFO]: Builder_Ana joined the game"],
        [15, "[Server thread/INFO]: kenjimori has made the advancement [Diamonds!]"],
        [12, "[Server thread/INFO]: <Builder_Ana> the bridge to spawn is finished"],
        [9, "[Server thread/INFO]: Saving the game (this may take a moment!)"],
        [9, "[Server thread/INFO]: Saved the game"],
        [6, "[Server thread/INFO]: RedstoneRiv joined the game"],
        [4, "[Server thread/INFO]: [Rcon: Mining rush starts now - 10 minutes]"],
        [2, "[Server thread/INFO]: <lena_f> gg"],
        [1, "[Server thread/INFO]: There are 7 of a max of 20 players online: Alex, nightowl, Builder_Ana, kenjimori, RedstoneRiv, lena_f, PixelPriya"]
    ]
        .map(([minutes, line]) => `[${at(minutes as number)}] ${line}`)
        .join("\n");
}

/** Commands kept as buttons on the console. */
export function survivalCommands(ctx: SceneContext) {
    return {
        commands: [
            { id: "cmd-1", label: ctx.say("Day time", "Hacer de día"), command: "time set day" },
            { id: "cmd-2", label: ctx.say("Clear weather", "Despejar"), command: "weather clear" },
            { id: "cmd-3", label: ctx.say("Save world", "Guardar mundo"), command: "save-all" },
            { id: "cmd-4", label: ctx.say("Who is on", "Quién está"), command: "list" }
        ]
    };
}
