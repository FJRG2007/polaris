/**
 * The chat moderation route, from a Minecraft server's side.
 *
 * What is pinned: rules and reports are taken only from the server named, with
 * its token, while Polaris's mod or plugin is switched on there; the rules come
 * with the warnings in the server's language to fall back on; every field of a
 * report is checked; a stopped line is kept, and the player is warned in their
 * own language - their linked account's, otherwise the server's - with the stop
 * before the limit saying that the next one counts, and the one at the limit
 * timing them out through the timeout service, which records the sanction.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const SERVER = "01a0a00b-35c5-7932-861e-1b2161a9b298";
const NOW = Date.parse("2026-09-30T12:00:00.000Z");

const fake = vi.hoisted(() => ({
    rows: [] as { player: string; action: string; at: Date; reason: string }[],
    env: new Map<string, string>(),
    config: {} as Record<string, unknown>,
    links: new Map<string, string>(),
    locales: new Map<string, string>(),
    timeouts: [] as { player: string; minutes: number; reason?: string }[]
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findFirst: async () => ({ applicationId: "app-1", ownerId: "owner-1" }),
            findUnique: async () => ({ ownerId: "owner-1", config: fake.config, applicationId: "app-1" })
        },
        gamePlayerLink: {
            findFirst: async ({ where }: { where: { player: { equals: string } } }) => {
                const userId = fake.links.get(where.player.equals.toLowerCase());
                return userId ? { userId } : null;
            }
        },
        minecraftChatBlock: {
            count: async ({ where }: { where: { player: string; at: { gt: Date } } }) =>
                fake.rows.filter((row) => row.player === where.player && row.at > where.at.gt).length,
            findFirst: async ({ where }: { where: { player: string } }) =>
                fake.rows.filter((row) => row.player === where.player && row.action === "timeout").at(-1) ??
                null,
            create: async ({ data }: { data: (typeof fake.rows)[number] }) => {
                fake.rows.push(data);
                return data;
            },
            deleteMany: async () => ({ count: 0 })
        }
    }
}));

vi.mock("@polaris/app-host", () => ({
    host: {
        domainService: { publicAppUrl: async () => "https://polaris.example" },
        notificationService: { createNotification: async () => undefined },
        envVarService: {
            listEnvVars: async () => [...fake.env].map(([key, value]) => ({ key, value }))
        },
        appsInstallSecret: { readInstallEnvSecret: async () => "the-token" },
        appsInstallConfig: {
            readInstallConfig: (config: Record<string, unknown>) => config,
            patchInstallConfig: async () => undefined
        },
        rateLimitService: { rateLimit: async () => ({ ok: true, retryAfterMs: 0 }) },
        i18nLocaleService: {
            getUserLocale: async (id: string) => fake.locales.get(id) ?? "en-US",
            storedLocale: async (id: string) => fake.locales.get(id) ?? null
        }
    }
}));

vi.mock("@polaris-app/game-servers/src/lib/minecraft/timeout-service", () => ({
    timeoutPlayer: async (_owner: string, _id: string, player: string, minutes: number, reason?: string) => {
        fake.timeouts.push({ player, minutes, reason });
        return { player, until: "" };
    }
}));

const { GET, POST } = await import("@polaris-app/game-servers/src/routes/api/minecraft/chat/[id]/route");

function call(method: "GET" | "POST", body?: unknown, token = "the-token", id = SERVER) {
    const request = new Request(`https://polaris.example/api/minecraft/chat/${id}`, {
        method,
        headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "user-agent": "Polaris-Minecraft/0.1.0+abc"
        },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body)
    });
    const context = { params: Promise.resolve({ id }) };
    return method === "GET" ? GET(request, context) : POST(request, context);
}

const block = (over: Record<string, unknown> = {}) => ({
    player: "Alba",
    uuid: "b6f17181-9a33-35da-ac7a-dc016f891bd9",
    reason: "advertising",
    detail: "play.other.net",
    text: "join play.other.net",
    command: false,
    at: NOW,
    ...over
});

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    fake.rows = [];
    fake.timeouts = [];
    fake.config = {};
    fake.links = new Map();
    fake.locales = new Map([["owner-1", "en-US"]]);
    fake.env = new Map([
        ["MODS", "https://polaris.example/api/minecraft/mod/polaris-anticheat-bukkit.jar"],
        ["POLARIS_ANTICHEAT", "on"]
    ]);
});

describe("the rules", () => {
    it("are handed to the server with its token, fallback warnings included", async () => {
        const answer = await call("GET");
        expect(answer.status).toBe(200);
        const body = (await answer.json()) as Record<string, unknown>;
        expect(body).toMatchObject({ enabled: true, advertising: true, flood: true });
        expect((body.fallback as Record<string, string>).advertising).toContain("Advertising");
    });

    it("are refused with a wrong token, the engine off, or an id that is not one", async () => {
        expect((await call("GET", undefined, "wrong")).status).toBe(401);
        expect((await call("GET", undefined, "the-token", "nope")).status).toBe(401);
        fake.env.set("POLARIS_ANTICHEAT", "off");
        expect((await call("GET")).status).toBe(401);
    });
});

describe("a stopped line", () => {
    it("is kept and answered with the warning in the server's language", async () => {
        const answer = await call("POST", block());
        expect(answer.status).toBe(200);
        expect(await answer.json()).toEqual({
            warn: "Advertising other servers is not allowed. Your message was not sent.",
            action: "warn"
        });
        expect(fake.rows).toEqual([
            expect.objectContaining({ player: "alba", reason: "advertising", action: "warn" })
        ]);
    });

    it("is answered in a linked player's own language", async () => {
        fake.links.set("bruno", "user-2");
        fake.locales.set("user-2", "es-ES");
        const answer = await call("POST", block({ player: "Bruno", reason: "flood" }));
        expect(((await answer.json()) as { warn: string }).warn).toBe("Más despacio: tu mensaje no se envió.");
    });

    it("says the next one counts, then times the player out", async () => {
        await call("POST", block());
        const second = (await (await call("POST", block())).json()) as { warn: string };
        expect(second.warn).toContain("One more and you will be removed for 10 min.");
        const third = (await (await call("POST", block())).json()) as { warn: string; action: string };
        expect(third.action).toBe("timeout");
        await vi.runAllTimersAsync();
        expect(fake.timeouts).toEqual([
            { player: "Alba", minutes: 10, reason: "Removed for 10 min for breaking the chat rules." }
        ]);
        // Back from it, a player starts counting again.
        const after = (await (await call("POST", block())).json()) as { action: string };
        expect(after.action).toBe("warn");
    });

    it("refuses a bad name, an unknown reason, a long line or a bad body", async () => {
        for (const body of [
            block({ player: "not a name!" }),
            block({ reason: "rude" }),
            block({ text: "x".repeat(257) }),
            block({ text: "" }),
            "not json"
        ]) {
            expect((await call("POST", body)).status).toBe(400);
        }
        expect(fake.rows).toEqual([]);
    });
});
