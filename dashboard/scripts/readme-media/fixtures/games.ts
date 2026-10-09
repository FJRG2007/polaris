/** A few servers for friends and a community: two Minecraft worlds, ARK, FiveM. */

import { id } from "./people";
import type { SceneContext } from "../runtime/scene";
import type { GameServerSeed } from "../../../apps/game-servers/src/screens/list";
import type {
    GameServerFacts,
    GameServerLive
} from "../../../apps/game-servers/src/lib/games-service";

export function gameServers(ctx: SceneContext): GameServerSeed[] {
    const server = (
        n: number,
        name: string,
        catalogId: string,
        catalogName: string,
        game: GameServerSeed["game"],
        status: string,
        favorite = false
    ): GameServerSeed => ({
        id: id("game-server", n),
        name,
        catalogId,
        catalogName,
        game,
        applicationId: id("application", 20 + n),
        status,
        canManage: true,
        canRemove: true,
        favorite,
        archived: false
    });
    return [
        server(
            1,
            ctx.say("Survival", "Supervivencia"),
            "minecraft",
            "Minecraft (Java)",
            "minecraft",
            "running",
            true
        ),
        server(
            2,
            ctx.say("Creative builds", "Construcciones"),
            "minecraft",
            "Minecraft (Java)",
            "minecraft",
            "running"
        ),
        server(3, "The Island", "ark", "ARK: Survival Evolved", "ark", "running"),
        server(4, "Roleplay City", "fivem", "FiveM", "fivem", "stopped")
    ];
}

interface Extra {
    readonly address: string | null;
    readonly slots: number;
    readonly release?: string;
    readonly software?: string;
    readonly edition?: string;
    readonly online: number;
    readonly players: readonly string[];
    readonly upMinutes: number | null;
}

const EXTRA: readonly Extra[] = [
    {
        address: "play.example.com",
        slots: 20,
        release: "1.21.4",
        software: "Paper",
        edition: "java",
        online: 7,
        players: [
            "Alex",
            "nightowl",
            "Builder_Ana",
            "kenjimori",
            "RedstoneRiv",
            "lena_f",
            "PixelPriya"
        ],
        upMinutes: 60 * 31
    },
    {
        address: "build.example.com",
        slots: 10,
        release: "1.21.4",
        software: "Fabric",
        edition: "java",
        online: 2,
        players: ["Builder_Ana", "lena_f"],
        upMinutes: 60 * 6
    },
    {
        address: "ark.example.com:7777",
        slots: 30,
        online: 4,
        players: ["Rex Tamer", "Doedicurus", "Kenji", "Sam"],
        upMinutes: 60 * 50
    },
    { address: "fivem.example.com:30120", slots: 48, online: 0, players: [], upMinutes: null }
];

export function gameFacts(ctx: SceneContext): GameServerFacts[] {
    return gameServers(ctx).map((seed, index) => {
        const extra = EXTRA[index]!;
        const running = seed.status === "running";
        return {
            id: seed.id,
            name: seed.name,
            catalogId: seed.catalogId,
            catalogName: seed.catalogName,
            game: seed.game,
            applicationId: seed.applicationId,
            serverName: "Local",
            running,
            address: extra.address,
            slots: extra.slots,
            release: extra.release ?? null,
            software: extra.software ?? null,
            edition: extra.edition ?? null,
            crossplay: false,
            lastOnlineAt: running
                ? new Date(ctx.now).toISOString()
                : new Date(ctx.now - 3 * 86_400_000).toISOString(),
            onlineSince:
                extra.upMinutes === null
                    ? null
                    : new Date(ctx.now - extra.upMinutes * 60_000).toISOString(),
            message: null
        };
    });
}

export function gameLive(ctx: SceneContext): GameServerLive[] {
    return gameServers(ctx).map((seed, index) => {
        const extra = EXTRA[index]!;
        const running = seed.status === "running";
        return {
            id: seed.id,
            answering: running,
            containerRunning: running,
            online: extra.online,
            max: extra.slots,
            players: extra.players,
            message: null,
            crashLoop: null
        };
    });
}
