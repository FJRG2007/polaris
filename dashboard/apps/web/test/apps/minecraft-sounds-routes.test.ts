/**
 * The three doors to a server's sounds: the upload from its Sounds tab, the pack
 * players download, and what the server's jar is told to hand out.
 *
 * Everything that comes through the upload is a stranger's bytes until it has
 * been read as the game will read it, so what is pinned here is what is refused
 * before anything is kept; the pack is reached with a token and a checksum, and
 * a pack that is no longer the library's is never served under its old name.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodePcm } from "@polaris-app/game-servers/src/lib/minecraft/sound-encode";

process.env.POLARIS_AUTH_SECRET ??= "a-long-enough-string-for-the-schema";
process.env.POLARIS_DATABASE_URL ??= "postgresql://fixture:fixture@localhost:5432/fixture";
process.env.POLARIS_MASTER_KEY ??= "fixture-master-key-fixture-master-key-0000";

const SERVER = "0190c0de-0000-7000-8000-0000000000a1";
const ORIGIN = "https://polaris.example";

type SoundRow = {
    id: string;
    installedAppId: string;
    key: string;
    name: string;
    data: Buffer;
    sha1: string;
    size: number;
    channels: number;
    sampleRate: number;
    seconds: number;
    subtitle: string;
    stream: boolean;
    replaces: string;
    updatedAt: Date;
};

const db = vi.hoisted(() => ({
    sounds: [] as SoundRow[],
    packs: new Map<string, { revision: number; settings: string }>()
}));

function pick<T extends object>(row: T, select?: Record<string, boolean>): Partial<T> {
    if (!select) return row;
    return Object.fromEntries(Object.entries(row).filter(([key]) => select[key])) as Partial<T>;
}

const locks = vi.hoisted(() => [] as unknown[][]);

vi.mock("@polaris/db", () => {
    // One transaction at a time, as the advisory lock makes it on one server.
    let turn: Promise<unknown> = Promise.resolve();
    const prisma = {
        $transaction: vi.fn((work: (tx: unknown) => Promise<unknown>) => {
            const run = turn.then(() => work(prisma));
            turn = run.catch(() => undefined);
            return run;
        }),
        $executeRaw: vi.fn(async (_sql: TemplateStringsArray, ...values: unknown[]) => {
            locks.push(values);
            return 1;
        }),
        minecraftSound: {
            findMany: vi.fn(async ({ where, select }: { where: { installedAppId: string }; select?: Record<string, boolean> }) => {
                const rows = db.sounds.filter((row) => row.installedAppId === where.installedAppId).map((row) => pick(row, select));
                // The answer is what the table held when it was read, and it takes a while to arrive.
                await new Promise((resolve) => setTimeout(resolve, 20));
                return rows;
            }),
            findFirst: vi.fn(async ({ where, select }: { where: { installedAppId: string; key?: string; id?: string }; select?: Record<string, boolean> }) => {
                const row = db.sounds.find(
                    (one) =>
                        one.installedAppId === where.installedAppId &&
                        (where.key === undefined || one.key === where.key) &&
                        (where.id === undefined || one.id === where.id)
                );
                return row ? pick(row, select) : null;
            }),
            create: vi.fn(async ({ data, select }: { data: Omit<SoundRow, "id" | "updatedAt" | "subtitle" | "replaces">; select?: Record<string, boolean> }) => {
                const row: SoundRow = {
                    subtitle: "",
                    replaces: "",
                    ...data,
                    id: `0190c0de-0000-7000-8000-${String(db.sounds.length + 1).padStart(12, "0")}`,
                    updatedAt: new Date("2026-10-10T00:00:00Z")
                };
                db.sounds.push(row);
                return pick(row, select);
            })
        },
        minecraftSoundPack: {
            upsert: vi.fn(async ({ where }: { where: { installedAppId: string } }) => {
                const current = db.packs.get(where.installedAppId) ?? { revision: 0, settings: "{}" };
                db.packs.set(where.installedAppId, { ...current, revision: current.revision + 1 });
            }),
            findUnique: vi.fn(async ({ where }: { where: { installedAppId: string } }) => db.packs.get(where.installedAppId) ?? null)
        },
        installedApp: {
            findUnique: vi.fn(async () => ({ name: "Survival", ownerId: "owner" })),
            findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
                where.id === SERVER ? { applicationId: "app-1", ownerId: "owner" } : null
            )
        }
    };
    return { prisma };
});

const requireGameServer = vi.hoisted(() => vi.fn());
vi.mock("@/lib/apps/install-access", () => ({ requireGameServer }));
vi.mock("@/lib/i18n/request", () => ({ getLocale: async () => "en-US" }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock("@/lib/apps/install-secret", () => ({
    readInstallEnvSecret: vi.fn(async (applicationId: string) => (applicationId === "app-1" ? "server-token" : null))
}));
vi.mock("@/lib/domain-service", () => ({
    publicAppUrl: async () => ORIGIN,
    appBaseUrl: async () => ORIGIN
}));
// No server is running here: nothing is told to hand the pack out.
vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    withServerContainer: vi.fn(async () => false)
}));

const upload = await import("@polaris-app/game-servers/src/routes/api/apps/installed/[id]/minecraft/sounds/route");
const pack = await import("@polaris-app/game-servers/src/routes/api/minecraft/sounds/[id]/[token]/[file]/route");
const jar = await import("@polaris-app/game-servers/src/routes/api/minecraft/sounds/[id]/route");
const { soundPackToken } = await import("@polaris-app/game-servers/src/lib/minecraft/sounds-service");

const require = createRequire(import.meta.url);
const WASM = new Uint8Array(readFileSync(require.resolve("wasm-media-encoders/wasm/ogg.wasm")));

async function vorbis(): Promise<Uint8Array> {
    const samples = new Float32Array(22_050);
    for (let at = 0; at < samples.length; at++) samples[at] = 0.2 * Math.sin((2 * Math.PI * 440 * at) / 44_100);
    return encodePcm([samples], 44_100, 4, WASM);
}

function send(body: BodyInit, options: { name?: string; origin?: string | null; length?: string } = {}) {
    const headers: Record<string, string> = { host: "polaris.example", "content-type": "audio/ogg" };
    if (options.origin !== null) headers.origin = options.origin ?? ORIGIN;
    if (options.length) headers["content-length"] = options.length;
    const request = new Request(
        `${ORIGIN}/api/apps/installed/${SERVER}/minecraft/sounds?name=${encodeURIComponent(options.name ?? "Victory fanfare")}`,
        { method: "POST", headers, body }
    );
    return upload.POST(request, { params: Promise.resolve({ id: SERVER }) });
}

beforeEach(() => {
    db.sounds.length = 0;
    db.packs.clear();
    locks.length = 0;
    requireGameServer.mockReset();
    requireGameServer.mockResolvedValue({ user: { id: "user" }, access: { ownerId: "owner", install: { applicationId: "app-1" } } });
});

describe("uploading a sound", () => {
    it("keeps an Ogg Vorbis file under a key made from its name", async () => {
        const response = await send(await vorbis());
        expect(response.status).toBe(200);
        const body = (await response.json()) as { sound: { key: string; channels: number; seconds: number } };
        expect(body.sound).toMatchObject({ key: "victory_fanfare", channels: 1, seconds: 0.5 });
        expect(db.sounds).toHaveLength(1);
    });

    it("refuses what is not Ogg Vorbis, keeping nothing", async () => {
        const mp3 = new Uint8Array(4096);
        mp3.set([0x49, 0x44, 0x33]);
        const response = await send(mp3);
        expect(response.status).toBe(400);
        expect(((await response.json()) as { error: string }).error).toMatch(/\S/);
        expect(db.sounds).toHaveLength(0);
    });

    it("refuses a body past one sound's limit, whatever length it claims", async () => {
        const big = new Uint8Array(8 * 1024 * 1024 + 1);
        expect((await send(big, { length: "10" })).status).toBe(413);
        expect((await send(new Uint8Array(10), { length: String(9 * 1024 * 1024) })).status).toBe(413);
        expect(db.sounds).toHaveLength(0);
    });

    it("refuses a request from another site or from somebody who cannot manage the server", async () => {
        expect((await send(await vorbis(), { origin: "https://evil.example" })).status).toBe(403);
        expect((await send(await vorbis(), { origin: null })).status).toBe(403);
        requireGameServer.mockRejectedValueOnce(new Error("no"));
        expect((await send(await vorbis())).status).toBe(403);
        expect(db.sounds).toHaveLength(0);
    });

    it("takes the server's library lock, so uploads at once each get their own key", async () => {
        const file = await vorbis();
        const [first, second] = await Promise.all([send(file), send(file)]);
        expect([first.status, second.status]).toEqual([200, 200]);
        expect(db.sounds.map((row) => row.key).sort()).toEqual(["victory_fanfare", "victory_fanfare_2"]);
        expect(locks).toEqual([[`polaris.minecraft.sounds:${SERVER}`], [`polaris.minecraft.sounds:${SERVER}`]]);
    });

    it("refuses a name with nothing usable in it", async () => {
        expect((await send(await vorbis(), { name: "***" })).status).toBe(400);
    });
});

describe("the pack players download", () => {
    function get(file: string, token = soundPackToken(SERVER)) {
        return pack.GET(new Request(`${ORIGIN}/x`), { params: Promise.resolve({ id: SERVER, token, file }) });
    }

    it("is served under its checksum and as the latest, and the jar is told that checksum", async () => {
        await send(await vorbis());
        const config = await jar.GET(
            new Request(`${ORIGIN}/api/minecraft/sounds/${SERVER}`, { headers: { authorization: "Bearer server-token" } }),
            { params: Promise.resolve({ id: SERVER }) }
        );
        expect(config.status).toBe(200);
        const told = (await config.json()) as { pack: { id: string; url: string; sha1: string; kick: string } };
        expect(told.pack.kick).toBe("This server needs its sound pack. Join again and accept it.");
        expect(told.pack.url).toBe(`${ORIGIN}/api/minecraft/sounds/${SERVER}/${soundPackToken(SERVER)}/${told.pack.sha1}.zip`);
        expect(told.pack.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

        const byChecksum = await get(`${told.pack.sha1}.zip`);
        expect(byChecksum.status).toBe(200);
        expect(byChecksum.headers.get("cache-control")).toContain("immutable");
        const { createHash } = await import("node:crypto");
        expect(createHash("sha1").update(new Uint8Array(await byChecksum.arrayBuffer())).digest("hex")).toBe(told.pack.sha1);
        const latest = await get("latest.zip");
        expect(latest.status).toBe(200);
        expect(latest.headers.get("cache-control")).toBe("no-store");
    });

    it("answers a wrong token, an old checksum and a stray name with 404", async () => {
        await send(await vorbis());
        expect((await get("latest.zip", "x".repeat(32))).status).toBe(404);
        expect((await get(`${"0".repeat(40)}.zip`)).status).toBe(404);
        expect((await get("../../etc/passwd")).status).toBe(404);
    });

    it("tells the jar nothing without the server's own token", async () => {
        const ask = (authorization?: string) =>
            jar.GET(
                new Request(`${ORIGIN}/api/minecraft/sounds/${SERVER}`, {
                    headers: authorization ? { authorization } : {}
                }),
                { params: Promise.resolve({ id: SERVER }) }
            );
        expect((await ask()).status).toBe(401);
        expect((await ask("Bearer guess")).status).toBe(401);
    });
});
