/**
 * The MLS device the server runs for Polar (and a webhook): its state, outbox
 * and notes in `MlsStoreEntry`, its ops in-process through the route's own
 * checks, one operation at a time per device. Against a person's device over
 * the route: Polar is added like anybody, reads the group, and posts a sealed
 * message as itself that the person opens; a second run restores the same
 * member from the database instead of making a new one. Skipped where the Node
 * binding is not built (CI's MLS job requires it).
 */

import "fake-indexeddb/auto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
    tables: {} as Record<string, Row[]>,
    user: null as { id: string } | null,
    members: new Set<string>(),
    seq: 0n,
    leased: 0,
    mostLeased: 0
}));

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: Buffer.alloc(32, 9).toString("base64") }) }));
vi.mock("@/lib/session", () => ({ backgroundUser: async () => state.user }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/chat/messages", () => ({
    send: async (actor: { id: string }, input: { channelId: string; body: string; clientKey?: string }, ...rest: unknown[]) => {
        const id = crypto.randomUUID();
        (state.tables.chatMessage ??= []).push({ id, channelId: input.channelId, authorId: actor.id, clientKey: input.clientKey, body: input.body, deletedAt: null, ...(rest[5] as Row) });
        return id;
    }
}));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));
vi.mock("@/lib/chat/vanish", () => ({ expiryForChannel: async () => null }));
vi.mock("@/lib/chat/chat-lock", () => ({ unhideOnMessage: async () => undefined }));
vi.mock("@/lib/chat/access", () => ({
    channelAccess: async (actor: { id: string }, channelId: string) => (state.members.has(`${actor.id}:${channelId}`) ? { id: channelId } : null),
    conversationAudience: async (actor: { id: string }, channelId: string) =>
        state.members.has(`${actor.id}:${channelId}`) ? [...state.members].filter((m) => m.endsWith(`:${channelId}`)).map((m) => m.slice(0, m.indexOf(":"))) : null
}));
// One holder at a time, counted, the way the `Setting` row's compare-and-swap decides.
vi.mock("@/lib/cron/lease", () => ({
    withLease: async <T,>(_key: string, _ttl: number, work: () => Promise<T>) => {
        if (state.leased) return null;
        state.leased++;
        state.mostLeased = Math.max(state.mostLeased, state.leased);
        try {
            return await work();
        } finally {
            state.leased--;
        }
    }
}));
vi.mock("@polaris/db", async () => ({ prisma: (await import("./support/mls-tables")).memoryPrisma(state) }));

const { handleMls } = await import("@/lib/chat/e2ee/mls-handler");
const { MlsDevice, MlsRequestError } = await import("@/lib/chat/e2ee/mls-client");
const { IndexedDbMlsStore } = await import("@polaris/core-rs/mls-store");
const { withServiceDevice } = await import("@/lib/chat/e2ee/service-device");
const { POLAR_SERVICE_ID, WEBHOOK_SERVICE_ID, serviceDevice } = await import("@/lib/chat/service-members");
const { RESERVED_PREFIX } = await import("@/lib/chat/e2ee/mls-store");
type MlsMemberClass = import("@/lib/chat/e2ee/mls-client").MlsMemberClass;
type MlsTransport = import("@/lib/chat/e2ee/mls-client").MlsTransport;

const ALICE = "11111111-1111-4111-8111-111111111111";
const CHANNEL = "44444444-4444-4444-8444-444444444444";
const POLAR_ADDRESS = `${POLAR_SERVICE_ID}/${serviceDevice(CHANNEL)}`;

const nativeDir = join(dirname(fileURLToPath(import.meta.url)), "../../../../../packages/core-rs/native");
const nativeFile = existsSync(nativeDir) ? readdirSync(nativeDir).find((f) => f.startsWith(`polaris-core.${process.platform}-${process.arch}`)) : undefined;
if (process.env.POLARIS_REQUIRE_CORE_RS_NATIVE && !nativeFile) throw new Error(`no Node binding of @polaris/core-rs for ${process.platform}-${process.arch} in ${nativeDir}`);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

beforeEach(() => {
    process.env.POLARIS_INTERNAL_CHAT_E2EE = "1";
    state.tables = { chatChannel: [{ id: CHANNEL, lastMessageAt: null }] };
    state.seq = 0n;
    state.leased = 0;
    state.mostLeased = 0;
    state.members = new Set([`${ALICE}:${CHANNEL}`, `${POLAR_SERVICE_ID}:${CHANNEL}`]);
});

describe("a service device with the flag off", () => {
    it("refuses before it loads anything", async () => {
        process.env.POLARIS_INTERNAL_CHAT_E2EE = "0";
        await expect(withServiceDevice("polar", CHANNEL, async () => "ran")).rejects.toThrow(/off/);
        expect(state.tables.mlsStoreEntry ?? []).toEqual([]);
    });
});

describe.skipIf(!nativeFile)("Polar's device against a person's", () => {
    const { MlsMember } = (nativeFile ? createRequire(import.meta.url)(join(nativeDir, nativeFile)) : {}) as { MlsMember: MlsMemberClass };
    const asAlice: MlsTransport = async (body) => {
        state.user = { id: ALICE };
        const response = await handleMls(new Request("http://x/api/e2ee/mls", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
        const answer = (await response.json()) as Record<string, unknown>;
        if (!response.ok) throw new MlsRequestError(response.status, String(answer.error));
        return answer;
    };
    const notes = new Map<string, string>();
    const alice = async () =>
        MlsDevice.open({
            userId: ALICE,
            device: `alice-${crypto.randomUUID().slice(0, 8)}`,
            MlsMember,
            store: await IndexedDbMlsStore.open(crypto.randomUUID()),
            transport: asAlice,
            notes: { getItem: (k) => notes.get(k) ?? null, setItem: (k, v) => void notes.set(k, v) }
        });
    const polar = <T,>(work: (device: InstanceType<typeof MlsDevice>) => Promise<T>) => withServiceDevice("polar", CHANNEL, work, { MlsMember });
    const storeRows = () => (state.tables.mlsStoreEntry ?? []).filter((r) => r.device === POLAR_ADDRESS);
    const reservedNames = () =>
        storeRows()
            .map((r) => Buffer.from(r.key as Uint8Array).toString("utf8"))
            .filter((k) => k.startsWith(RESERVED_PREFIX))
            .map((k) => k.slice(RESERVED_PREFIX.length));

    it("is added like a person, reads the group, and posts a sealed message the person opens", async () => {
        const person = await alice();
        await person.register();
        // Registered with its key packages on first use, its state sealed in the database.
        await polar(async () => undefined);
        expect(state.tables.mlsDevice?.filter((r) => r.userId === POLAR_SERVICE_ID)).toHaveLength(1);
        expect(state.tables.mlsKeyPackage?.filter((r) => r.userId === POLAR_SERVICE_ID)).toHaveLength(20);
        expect(storeRows().length).toBeGreaterThan(0);
        expect(storeRows().every((r) => !Buffer.from(r.ciphertext as Uint8Array).includes(Buffer.from(POLAR_SERVICE_ID)))).toBe(true);

        await person.ensureGroup(CHANNEL);
        expect(await person.addAccounts(CHANNEL, [POLAR_SERVICE_ID])).toEqual([POLAR_ADDRESS]);
        await person.sendApplication(CHANNEL, encoder.encode("hello polar"));

        const heard = await polar(async (device) => {
            await device.ensureGroup(CHANNEL);
            return (await device.sync(CHANNEL)).map((m) => decoder.decode(m.plaintext));
        });
        expect(heard).toEqual(["hello polar"]);

        const id = await polar((device) => device.sendSealed(CHANNEL, encoder.encode("hello alice")));
        const row = state.tables.chatMessage?.find((r) => r.id === id);
        expect(row).toMatchObject({ authorId: null, agent: "polar", authorLabel: "Polar", body: "", e2eeDevice: serviceDevice(CHANNEL) });
        const [opened] = await person.readSealed(CHANNEL, [id]);
        expect(opened?.opened && decoder.decode(opened.opened)).toBe("hello alice");

        // Nothing left waiting to be sent; the notes it needs are kept.
        expect(reservedNames().filter((n) => n.startsWith("outbox/"))).toEqual([]);
        expect(reservedNames().some((n) => n.endsWith("signature-key"))).toBe(true);
        expect(reservedNames().some((n) => n.startsWith("hk/"))).toBe(true);
    });

    it("restores the same member on the next run instead of making a new one", async () => {
        const first = await polar(async (device) => device.address);
        const key = state.tables.mlsDevice?.find((r) => r.userId === POLAR_SERVICE_ID)?.signatureKey;
        const second = await polar(async (device) => device.address);
        expect(second).toBe(first);
        expect(state.tables.mlsDevice?.find((r) => r.userId === POLAR_SERVICE_ID)?.signatureKey).toEqual(key);
        // Topped up once, not again: the restored member still holds them.
        expect(state.tables.mlsKeyPackage?.filter((r) => r.userId === POLAR_SERVICE_ID)).toHaveLength(20);
    });

    it("starts over when its state survived without the note that restores it", async () => {
        await polar(async () => undefined);
        state.tables.mlsStoreEntry = (state.tables.mlsStoreEntry ?? []).filter((r) => !Buffer.from(r.key as Uint8Array).toString("utf8").endsWith("signature-key"));
        const before = state.tables.mlsDevice?.find((r) => r.userId === POLAR_SERVICE_ID)?.signatureKey;
        await polar(async () => undefined);
        expect(state.tables.mlsDevice?.find((r) => r.userId === POLAR_SERVICE_ID)?.signatureKey).not.toEqual(before);
    });

    it("runs one operation at a time on a device, even when asked at once", async () => {
        await Promise.all([polar(async () => undefined), polar(async () => undefined), polar(async () => undefined)]);
        expect(state.mostLeased).toBe(1);
    });

    it("posts a webhook's sealed message under the webhook's name", async () => {
        const HOOK = "77777777-7777-4777-8777-777777777777";
        state.tables.chatWebhook = [{ id: HOOK, channelId: CHANNEL, name: "Deploys" }];
        state.members.add(`${WEBHOOK_SERVICE_ID}:${CHANNEL}`);
        const person = await alice();
        await person.register();
        await withServiceDevice("webhook", HOOK, async () => undefined, { MlsMember });
        await person.ensureGroup(CHANNEL);
        await person.addAccounts(CHANNEL, [WEBHOOK_SERVICE_ID]);
        const id = await withServiceDevice(
            "webhook",
            HOOK,
            async (device) => {
                await device.ensureGroup(CHANNEL);
                return device.sendSealed(CHANNEL, encoder.encode("build 42 is out"));
            },
            { MlsMember }
        );
        expect(state.tables.chatMessage?.find((r) => r.id === id)).toMatchObject({ authorId: null, agent: null, webhookId: HOOK, authorLabel: "Deploys" });
        const [opened] = await person.readSealed(CHANNEL, [id]);
        expect(opened?.opened && decoder.decode(opened.opened)).toBe("build 42 is out");
    });

    it("reaches only conversations it was added to", async () => {
        const person = await alice();
        await person.register();
        await person.ensureGroup(CHANNEL);
        state.members.delete(`${POLAR_SERVICE_ID}:${CHANNEL}`);
        await expect(polar((device) => device.ensureGroup(CHANNEL))).rejects.toMatchObject({ status: 403 });
    });
});
