/**
 * What the login mod is told when it asks.
 *
 * The route is the only thing between a stranger with a server's id and that
 * server's passwords, so what is pinned here is the gate - a wrong token and an
 * unknown server look the same - and the vocabulary the mod turns into sentences
 * for a player: a wrong password is 403, never 401, which the mod reads as "this
 * server's link is broken" and says to everybody.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const SERVER = "0190c0de-0000-7000-8000-000000000001";
const OTHER = "0190c0de-0000-7000-8000-000000000002";
const TOKEN = "server-token";

type Row = {
    username: string;
    displayName: string;
    passwordHash: string;
    lastLoginAt: Date | null;
};
const logins = new Map<string, Row>();
const checkIns = new Map<string, { seenAt: Date; modVersion: string; gameVersion: string }>();
const counters = new Map<string, { count: number; windowStart: Date }>();

const rowKey = (where: { installedAppId_username: { installedAppId: string; username: string } }) =>
    `${where.installedAppId_username.installedAppId}:${where.installedAppId_username.username}`;

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findUnique: vi.fn(async () => ({
                config: JSON.stringify({ bindAddresses: bound.value })
            })),
            findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
                where.id === SERVER || where.id === OTHER
                    ? { applicationId: `app-${where.id}`, ownerId: "owner" }
                    : null
            )
        },
        minecraftLogin: {
            findUnique: vi.fn(
                async ({ where }: { where: Parameters<typeof rowKey>[0] }) =>
                    logins.get(rowKey(where)) ?? null
            ),
            create: vi.fn(async ({ data }: { data: Row & { installedAppId: string } }) => {
                const id = `${data.installedAppId}:${data.username}`;
                if (logins.has(id)) throw Object.assign(new Error("unique"), { code: "P2002" });
                logins.set(id, data);
                return data;
            }),
            update: vi.fn(
                async ({
                    where,
                    data
                }: {
                    where: Parameters<typeof rowKey>[0];
                    data: Partial<Row>;
                }) => {
                    const id = rowKey(where);
                    logins.set(id, { ...(logins.get(id) as Row), ...data });
                }
            )
        },
        minecraftLoginCheckIn: {
            upsert: vi.fn(
                async ({
                    where,
                    update
                }: {
                    where: { installedAppId: string };
                    update: { seenAt: Date; modVersion: string; gameVersion: string };
                }) => {
                    checkIns.set(where.installedAppId, update);
                }
            )
        },
        rateLimitCounter: {
            findUnique: vi.fn(
                async ({ where }: { where: { key: string } }) => counters.get(where.key) ?? null
            )
        }
    }
}));

const rules = vi.hoisted(() => ({ value: [] as { username: string; address: string }[] }));
const bound = vi.hoisted(() => ({ value: true }));
/** What the door wrote down, so the owner can be told somebody was turned away. */
const noted = vi.hoisted(
    () => [] as { installedAppId: string; player: string; address: string | null; why: string }[]
);
vi.mock("@polaris-app/game-servers/src/lib/minecraft/player-access", () => ({
    playerAccessRules: vi.fn(async () => rules.value),
    noteRefusal: vi.fn(
        async (installedAppId: string, refusal: { player: string; address: string | null; why: string }) =>
            void noted.push({ installedAppId, ...refusal })
    )
}));

vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: vi.fn(async (key: string, limit: number) => {
        const row = counters.get(key) ?? { count: 0, windowStart: new Date() };
        if (row.count >= limit) return { ok: false, retryAfterMs: 60_000 };
        counters.set(key, { ...row, count: row.count + 1 });
        return { ok: true, retryAfterMs: 0 };
    }),
    resetRateLimit: vi.fn(async (key: string) => void counters.delete(key))
}));

const secrets = vi.hoisted(() => ({
    read: vi.fn(
        async (applicationId: string): Promise<string | null> =>
            applicationId.endsWith("0001") ? "server-token" : "another-token"
    )
}));
vi.mock("@/lib/apps/install-secret", () => ({ readInstallEnvSecret: secrets.read }));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: async () => "https://polaris.example" }));

const switchedOn = [
    { key: "MODS", value: "https://polaris.example/api/minecraft/mod/polaris-neoforge-1.21.4.jar" },
    { key: "POLARIS_LOGIN", value: "on" }
];
const env = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/lib/env-var-service", () => ({ listEnvVars: env.list, setEnvVars: vi.fn() }));

const route = await import("@polaris-app/game-servers/src/routes/api/minecraft/login/[id]/[action]/route");

function ask(action: string, body: unknown, options: { id?: string; token?: string } = {}) {
    const request = new Request(`https://polaris.example/api/minecraft/login/x/${action}`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${options.token ?? TOKEN}`,
            "content-type": "application/json"
        },
        body: typeof body === "string" ? body : JSON.stringify(body)
    });
    return route.POST(request, { params: Promise.resolve({ id: options.id ?? SERVER, action }) });
}

beforeEach(() => {
    rules.value = [];
    bound.value = true;
    logins.clear();
    checkIns.clear();
    counters.clear();
    noted.length = 0;
    env.list.mockReset();
    env.list.mockResolvedValue(switchedOn);
});

describe("who may ask", () => {
    it("is the server whose token it is", async () => {
        expect((await ask("status", { player: "Steve" })).status).toBe(200);
    });

    it("answers a wrong token and an unknown server the same way", async () => {
        const wrong = await ask("status", { player: "Steve" }, { token: "guess" });
        const unknown = await ask(
            "status",
            { player: "Steve" },
            { id: "0190c0de-0000-7000-8000-00000000ffff" }
        );
        const another = await ask("status", { player: "Steve" }, { id: OTHER });
        for (const response of [wrong, unknown, another]) {
            expect(response.status).toBe(401);
            expect(await response.json()).toEqual({ error: "unauthorized" });
        }
    });

    it("refuses a server that has the mod switched off", async () => {
        env.list.mockResolvedValue([{ key: "POLARIS_LOGIN", value: "off" }]);
        expect((await ask("status", { player: "Steve" })).status).toBe(401);
    });

    it("does not read a failed lookup as a broken link", async () => {
        secrets.read.mockRejectedValueOnce(new Error("decrypt failed"));
        await expect(ask("status", { player: "Steve" })).rejects.toThrow("decrypt failed");
        env.list.mockRejectedValueOnce(new Error("database down"));
        await expect(ask("status", { player: "Steve" })).rejects.toThrow("database down");
    });

    it("refuses a request with no token", async () => {
        const request = new Request("https://polaris.example/x", { method: "POST", body: "{}" });
        const response = await route.POST(request, {
            params: Promise.resolve({ id: SERVER, action: "status" })
        });
        expect(response.status).toBe(401);
    });
});

describe("registering and logging in", () => {
    it("registers once, then logs in with that password only", async () => {
        expect(await (await ask("status", { player: "Steve" })).json()).toEqual({
            registered: false
        });
        expect((await ask("register", { player: "Steve", password: "correct horse" })).status).toBe(
            200
        );
        expect(await (await ask("status", { player: "steve" })).json()).toEqual({
            registered: true
        });

        expect((await ask("login", { player: "Steve", password: "correct horse" })).status).toBe(
            200
        );
        const wrong = await ask("login", { player: "Steve", password: "wrong horse" });
        expect(wrong.status).toBe(403);
        expect(await wrong.json()).toEqual({ error: "wrong-password" });
    });

    it("never stores the password itself", async () => {
        await ask("register", { player: "Steve", password: "correct horse" });
        const row = [...logins.values()][0];
        expect(row?.passwordHash).not.toContain("correct horse");
        expect(row?.passwordHash.startsWith("scrypt$")).toBe(true);
    });

    it("does not let a second registration replace the first", async () => {
        await ask("register", { player: "Steve", password: "correct horse" });
        const again = await ask("register", { player: "STEVE", password: "someone else" });
        expect(again.status).toBe(409);
        expect((await ask("login", { player: "Steve", password: "someone else" })).status).toBe(
            403
        );
    });

    it("says a name has no password rather than that it is wrong", async () => {
        const response = await ask("login", { player: "Alex", password: "anything" });
        expect(response.status).toBe(404);
    });

    it("refuses a short password with a sentence the mod can show", async () => {
        const response = await ask("register", { player: "Steve", password: "abc" });
        expect(response.status).toBe(400);
        expect((await response.json()).message).toMatch(/at least 6 characters/);
    });

    it("refuses what is not a player name or not JSON", async () => {
        expect((await ask("status", { player: "two words" })).status).toBe(400);
        expect((await ask("status", "not json")).status).toBe(400);
        expect((await ask("nothing", {})).status).toBe(404);
    });

    it("changes a password only given the current one", async () => {
        await ask("register", { player: "Steve", password: "correct horse" });
        expect(
            (await ask("password", { player: "Steve", current: "nope", next: "battery staple" }))
                .status
        ).toBe(403);
        expect(
            (
                await ask("password", {
                    player: "Steve",
                    current: "correct horse",
                    next: "battery staple"
                })
            ).status
        ).toBe(200);
        expect((await ask("login", { player: "Steve", password: "battery staple" })).status).toBe(
            200
        );
    });
});

describe("guessing", () => {
    it("is throttled per player, with a Retry-After", async () => {
        await ask("register", { player: "Steve", password: "correct horse" });
        let last: Response | null = null;
        for (let attempt = 0; attempt < 11; attempt += 1) {
            last = await ask("login", { player: "Steve", password: `guess ${attempt}` });
        }
        expect(last?.status).toBe(429);
        expect(last?.headers.get("retry-after")).toBe("60");
        // The right password does not get through a closed bucket either.
        expect((await ask("login", { player: "Steve", password: "correct horse" })).status).toBe(
            429
        );
    });

    it("is throttled across names on the same server", async () => {
        counters.set(`mc-login-server:${SERVER}`, { count: 100, windowStart: new Date() });
        const response = await ask("login", { player: "Someone", password: "guess" });
        expect(response.status).toBe(429);
    });

    it("counts only failures against the server", async () => {
        await ask("register", { player: "Steve", password: "correct horse" });
        for (let attempt = 0; attempt < 5; attempt += 1) {
            await ask("login", { player: "Steve", password: "correct horse" });
        }
        expect(counters.get(`mc-login-server:${SERVER}`)).toBeUndefined();
        await ask("login", { player: "Steve", password: "wrong" });
        expect(counters.get(`mc-login-server:${SERVER}`)?.count).toBe(1);
    });
});

describe("checking in", () => {
    it("records what the mod is and what it runs on", async () => {
        expect((await ask("hello", { mod: "0.1.0", minecraft: "1.21.4" })).status).toBe(200);
        expect(checkIns.get(SERVER)).toMatchObject({ modVersion: "0.1.0", gameVersion: "1.21.4" });
    });
});

/**
 * The server's player list, asked before anybody can register a password. A name
 * that is not on it is turned away with the sentence the mod kicks them with.
 */
describe("the player list", () => {
    it("lets anybody through while the list is empty", async () => {
        const body = await (
            await ask("status", { player: "Steve", address: "203.0.113.9" })
        ).json();
        expect(body).toEqual({ registered: false });
    });

    it("turns away a name that is not on it, on every question", async () => {
        rules.value = [{ username: "Alex", address: "any" }];
        const status = await (
            await ask("status", { player: "Steve", address: "203.0.113.9" })
        ).json();
        expect(status.refused).toMatch(/not on this server's player list/);

        const registered = await ask("register", { player: "Steve", password: "correct horse" });
        expect(registered.status).toBe(403);
        expect((await registered.json()).refused).toMatch(/player list/);
        expect(logins.size).toBe(0);

        const login = await ask("login", { player: "Steve", password: "correct horse" });
        expect((await login.json()).refused).toMatch(/player list/);

        // Whoever runs the server hears about it here or nowhere: the player was
        // told to go and ask them, and has no other way of reaching them.
        expect(noted[0]).toMatchObject({ player: "Steve", address: "203.0.113.9" });
        expect(noted[0]?.why).toMatch(/player list/);
    });

    it("lets a listed name in from its own network", async () => {
        rules.value = [{ username: "steve", address: "203.0.113.0/24" }];
        const body = await (
            await ask("status", { player: "Steve", address: "203.0.113.9" })
        ).json();
        expect(body.refused).toBeUndefined();
        expect((await ask("register", { player: "Steve", password: "correct horse" })).status).toBe(
            200
        );
    });

    it("turns a listed name away from another network, unless the list is not bound", async () => {
        rules.value = [{ username: "Steve", address: "203.0.113.0/24" }];
        const away = await (
            await ask("status", { player: "Steve", address: "198.51.100.7" })
        ).json();
        expect(away.refused).toMatch(/different network/);
        expect(noted).toHaveLength(1);
        expect(noted[0]).toMatchObject({ player: "Steve", address: "198.51.100.7" });

        bound.value = false;
        const unbound = await (
            await ask("status", { player: "Steve", address: "198.51.100.7" })
        ).json();
        expect(unbound.refused).toBeUndefined();
    });

    it("judges a name alone when the address is not one", async () => {
        rules.value = [{ username: "Steve", address: "203.0.113.0/24" }];
        const body = await (await ask("status", { player: "Steve", address: "local" })).json();
        expect(body.refused).toBeUndefined();
    });
});
