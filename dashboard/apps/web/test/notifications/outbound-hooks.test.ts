/**
 * Signed webhooks: the signature an endpoint checks, the retry ladder, the claim
 * that keeps two runners from sending one row twice, switching an endpoint off
 * after five lost deliveries, redelivery as a new row, the log's pages and its
 * retention, and the per-account limits.
 */

import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Hook = {
    id: string;
    userId: string;
    name: string;
    urlHint: string;
    encryptedUrl: Uint8Array;
    urlNonce: Uint8Array;
    urlKeyId: string | null;
    encryptedSecret: Uint8Array;
    secretNonce: Uint8Array;
    secretKeyId: string | null;
    events: string[];
    requestConfig?: unknown;
    encryptedRequest?: Uint8Array | null;
    requestNonce?: Uint8Array | null;
    requestKeyId?: string | null;
    enabled: boolean;
    consecutiveFailures: number;
    disabledReason: string | null;
    lastDeliveryAt: Date | null;
    createdAt: Date;
};
type Delivery = {
    id: string;
    webhookId: string;
    event: string;
    payload: string;
    status: string;
    attempts: number;
    nextAttemptAt: Date | null;
    responseStatus: number | null;
    error: string | null;
    durationMs: number | null;
    deliveredAt: Date | null;
    createdAt: Date;
};

let hooks: Hook[] = [];
let deliveries: Delivery[] = [];
let seq = 0;
const nextId = () => `00000000-0000-7000-8000-${String(++seq).padStart(12, "0")}`;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Matches the subset of Prisma's `where` this service uses. */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, want]) => {
        const have = row[key];
        if (key === "webhook") {
            const hook = hooks.find((h) => h.id === row.webhookId);
            return hook ? matches(hook, want as Record<string, unknown>) : false;
        }
        if (want && typeof want === "object" && !(want instanceof Date)) {
            const op = want as { lte?: Date; lt?: Date; has?: string };
            if (op.lte) return have instanceof Date && have <= op.lte;
            if (op.lt) return have instanceof Date && have < op.lt;
            if (op.has) return Array.isArray(have) && have.includes(op.has);
        }
        return have === want;
    });
}

function apply<T extends Record<string, unknown>>(row: T, data: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(data)) {
        if (value && typeof value === "object" && "increment" in (value as object)) {
            (row as Record<string, unknown>)[key] =
                (row[key] as number) + (value as { increment: number }).increment;
        } else {
            (row as Record<string, unknown>)[key] = value;
        }
    }
}

const pick = <T extends Record<string, unknown>>(row: T) => ({ ...row });

vi.mock("@polaris/db", () => ({
    prisma: {
        outboundWebhook: {
            count: async ({ where }: { where: Record<string, unknown> }) =>
                hooks.filter((h) => matches(h, where)).length,
            create: async ({ data }: { data: Partial<Hook> }) => {
                const row: Hook = {
                    id: nextId(),
                    urlKeyId: null,
                    secretKeyId: null,
                    enabled: true,
                    consecutiveFailures: 0,
                    disabledReason: null,
                    lastDeliveryAt: null,
                    createdAt: new Date(),
                    ...(data as Hook)
                };
                hooks.push(row);
                return pick(row);
            },
            findMany: async ({ where }: { where: Record<string, unknown> }) =>
                hooks.filter((h) => matches(h, where)).map(pick),
            findFirst: async ({ where }: { where: Record<string, unknown> }) =>
                hooks.find((h) => matches(h, where)) ?? null,
            update: async ({
                where,
                data
            }: {
                where: { id: string };
                data: Record<string, unknown>;
            }) => {
                const row = hooks.find((h) => h.id === where.id)!;
                apply(row, data);
                return pick(row);
            },
            updateMany: async ({
                where,
                data
            }: {
                where: Record<string, unknown>;
                data: Record<string, unknown>;
            }) => {
                const rows = hooks.filter((h) => matches(h, where));
                rows.forEach((row) => apply(row, data));
                return { count: rows.length };
            },
            deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
                const before = hooks.length;
                hooks = hooks.filter((h) => !matches(h, where));
                return { count: before - hooks.length };
            }
        },
        outboundWebhookDelivery: {
            create: async ({ data }: { data: Partial<Delivery> }) => {
                const row: Delivery = {
                    id: nextId(),
                    status: "pending",
                    attempts: 0,
                    nextAttemptAt: null,
                    responseStatus: null,
                    error: null,
                    durationMs: null,
                    deliveredAt: null,
                    createdAt: new Date(),
                    ...(data as Delivery)
                };
                deliveries.push(row);
                return pick(row);
            },
            findUnique: async ({ where }: { where: { id: string } }) => {
                const row = deliveries.find((d) => d.id === where.id);
                if (!row) return null;
                return { ...row, webhook: hooks.find((h) => h.id === row.webhookId) };
            },
            findUniqueOrThrow: async ({ where }: { where: { id: string } }) =>
                pick(deliveries.find((d) => d.id === where.id)!),
            findFirst: async ({ where }: { where: Record<string, unknown> }) =>
                deliveries.find((d) => matches(d, where)) ?? null,
            findMany: async ({
                where,
                take,
                cursor
            }: {
                where: Record<string, unknown>;
                take: number;
                cursor?: { id: string };
            }) => {
                let rows = deliveries.filter((d) => matches(d, where));
                if ("webhookId" in where) rows = [...rows].sort((a, b) => b.id.localeCompare(a.id));
                if (cursor) rows = rows.slice(rows.findIndex((d) => d.id === cursor.id) + 1);
                return rows.slice(0, take).map(pick);
            },
            update: async ({
                where,
                data
            }: {
                where: { id: string };
                data: Record<string, unknown>;
            }) => {
                const row = deliveries.find((d) => d.id === where.id)!;
                apply(row, data);
                return pick(row);
            },
            updateMany: async ({
                where,
                data
            }: {
                where: Record<string, unknown>;
                data: Record<string, unknown>;
            }) => {
                const rows = deliveries.filter((d) => matches(d, where));
                rows.forEach((row) => apply(row, data));
                return { count: rows.length };
            },
            deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
                const before = deliveries.length;
                deliveries = deliveries.filter((d) => !matches(d, where));
                return { count: before - deliveries.length };
            }
        }
    }
}));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "k" }) }));
vi.mock("@polaris/storage", () => ({
    encryptSecret: (value: string) => ({
        ciphertext: enc.encode(value),
        nonce: new Uint8Array([1]),
        keyId: "k1"
    }),
    decryptSecret: (blob: { ciphertext: Uint8Array }) => dec.decode(blob.ciphertext)
}));

let allowRate = true;
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async () => ({ ok: allowRate, retryAfterMs: allowRate ? 0 : 1000 })
}));

const requests: Array<{ url: string; init: { headers: Record<string, string>; body: string } }> =
    [];
let respond: () => Promise<{ status: number }> = async () => ({ status: 200 });
vi.mock("@/lib/safe-fetch", () => {
    class RefusedAddressError extends Error {}
    return {
        RefusedAddressError,
        safeUrl: (value: string) => {
            try {
                return new URL(value);
            } catch {
                return null;
            }
        },
        reachable: async (host: string) => host !== "10.0.0.1",
        configuredRequest: async (
            url: string,
            init: { headers: Record<string, string>; body: string }
        ) => {
            requests.push({ url, init });
            const response = await respond();
            return { status: response.status, body: null };
        }
    };
});

const notified = vi.fn(async () => {});
vi.mock("../../src/lib/notifications/dispatch", () => ({
    notify: (input: unknown) => notified(input as never)
}));
vi.mock("../../src/lib/notifications/notice-words", () => ({
    wordsFor: async () => (key: string, values?: Record<string, string>) =>
        `${key}${values ? JSON.stringify(values) : ""}`
}));

const hooksModule = await import("../../src/lib/notifications/outbound-hooks");
const {
    attemptDelivery,
    createOutboundHook,
    DISABLE_AFTER_FAILURES,
    listOutboundDeliveries,
    queueOutboundHooks,
    listOutboundHooks,
    redeliverOutbound,
    RETRY_DELAYS_MS,
    setOutboundHookRequest,
    runOutboundHooks,
    signPayload,
    testOutboundHook
} = hooksModule;

const PAYLOAD = {
    event: "deploy.failed",
    level: "danger" as const,
    title: "Deploy failed",
    body: null,
    url: null,
    at: "2026-10-15T00:00:00.000Z"
};

async function addHook(events = ["deploy.failed"]): Promise<{ id: string; secret: string }> {
    const created = await createOutboundHook("u1", {
        name: "Ops",
        url: "https://hooks.example.test/in",
        events
    });
    if ("error" in created) throw new Error(created.error);
    return { id: created.hook.id, secret: created.secret };
}

beforeEach(() => {
    hooks = [];
    deliveries = [];
    requests.length = 0;
    allowRate = true;
    respond = async () => ({ status: 200 });
    notified.mockClear();
});

describe("signing", () => {
    it("signs timestamp.body with the secret, as an endpoint recomputes it", async () => {
        const { secret } = await addHook();
        await queueOutboundHooks("u1", PAYLOAD);
        expect(requests).toHaveLength(1);
        const { headers, body } = requests[0]!.init;
        const ts = headers["X-Polaris-Timestamp"]!;
        const expected = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
        expect(headers["X-Polaris-Signature"]).toBe(`sha256=${expected}`);
        expect(signPayload(secret, Number(ts), body)).toBe(`sha256=${expected}`);
        expect(JSON.parse(body)).toEqual(PAYLOAD);
        expect(secret.startsWith("whsec_")).toBe(true);
    });

    it("never keeps the URL or the secret in clear on the view", async () => {
        const created = await createOutboundHook("u1", {
            name: "Ops",
            url: "https://hooks.example.test/in/hooks/secret-path",
            events: ["deploy.failed"]
        });
        expect(JSON.stringify("hook" in created ? created.hook : {})).not.toContain("secret-path");
    });
});

describe("routing", () => {
    it("sends only to enabled endpoints of that account that asked for the event", async () => {
        await addHook(["deploy.succeeded"]);
        const off = await addHook();
        hooks.find((h) => h.id === off.id)!.enabled = false;
        await queueOutboundHooks("u1", PAYLOAD);
        await queueOutboundHooks("u2", PAYLOAD);
        expect(requests).toHaveLength(0);
    });
});

describe("retries", () => {
    it("walks the 1m, 5m, 30m, 2h, 6h ladder, then gives up", async () => {
        await addHook();
        respond = async () => ({ status: 500 });
        await queueOutboundHooks("u1", PAYLOAD);
        const row = deliveries[0]!;
        let now = Date.now();
        for (const delay of RETRY_DELAYS_MS) {
            expect(row.status).toBe("pending");
            expect(row.nextAttemptAt!.getTime() - now).toBeGreaterThanOrEqual(delay - 1000);
            now = row.nextAttemptAt!.getTime();
            await attemptDelivery(row.id, { now: new Date(now) });
        }
        expect(row.status).toBe("failed");
        expect(row.attempts).toBe(RETRY_DELAYS_MS.length + 1);
        expect(row.error).toBe("http");
        expect(row.responseStatus).toBe(500);
    });

    it("counts a redirect as a failure and does not follow it", async () => {
        await addHook();
        respond = async () => ({ status: 302 });
        await queueOutboundHooks("u1", PAYLOAD);
        expect(requests).toHaveLength(1);
        expect(deliveries[0]!.error).toBe("redirect");
        expect(deliveries[0]!.status).toBe("pending");
    });

    it("lets only one of two runners send a row", async () => {
        await addHook();
        let release!: () => void;
        respond = () => new Promise((resolve) => (release = () => resolve({ status: 200 })));
        const row = await (async () => {
            const hook = hooks[0]!;
            deliveries.push({
                id: nextId(),
                webhookId: hook.id,
                event: "deploy.failed",
                payload: "{}",
                status: "pending",
                attempts: 0,
                nextAttemptAt: new Date(Date.now() - 1000),
                responseStatus: null,
                error: null,
                durationMs: null,
                deliveredAt: null,
                createdAt: new Date()
            });
            return deliveries[0]!;
        })();
        const first = attemptDelivery(row.id);
        const second = attemptDelivery(row.id);
        await new Promise((resolve) => setTimeout(resolve, 5));
        release();
        expect(await Promise.all([first, second])).toEqual(expect.arrayContaining(["sent", null]));
        expect(requests).toHaveLength(1);
    });
});

describe("switching off", () => {
    it("switches an endpoint off after five lost deliveries in a row, and tells its owner once", async () => {
        const { id } = await addHook();
        respond = async () => ({ status: 503 });
        for (let i = 0; i < DISABLE_AFTER_FAILURES; i++) {
            await queueOutboundHooks("u1", PAYLOAD);
            const row = deliveries[deliveries.length - 1]!;
            while (row.status === "pending")
                await attemptDelivery(row.id, { now: row.nextAttemptAt! });
        }
        const hook = hooks.find((h) => h.id === id)!;
        expect(hook.enabled).toBe(false);
        expect(hook.disabledReason).toBe("failures");
        expect(notified).toHaveBeenCalledTimes(1);
        expect(notified.mock.calls[0]![0]).toMatchObject({
            userId: "u1",
            event: "webhook.disabled"
        });
    });

    it("starts the count over after a success", async () => {
        const { id } = await addHook();
        hooks[0]!.consecutiveFailures = 4;
        await queueOutboundHooks("u1", PAYLOAD);
        expect(hooks.find((h) => h.id === id)!.consecutiveFailures).toBe(0);
    });

    it("does not count a failed test against the endpoint", async () => {
        const { id } = await addHook();
        hooks[0]!.consecutiveFailures = 4;
        respond = async () => ({ status: 500 });
        const result = await testOutboundHook("u1", id, {
            level: "info",
            title: "t",
            body: null,
            url: null
        });
        expect(result).toMatchObject({ status: "failed" });
        expect(hooks[0]!.enabled).toBe(true);
        expect(hooks[0]!.consecutiveFailures).toBe(4);
    });
});

describe("redelivery", () => {
    it("sends the same body as a new row and leaves the original alone", async () => {
        await addHook();
        await queueOutboundHooks("u1", PAYLOAD);
        const original = deliveries[0]!;
        const result = await redeliverOutbound("u1", original.id);
        expect(result).toMatchObject({ status: "sent" });
        expect(deliveries).toHaveLength(2);
        expect(deliveries[1]!.payload).toBe(original.payload);
        expect(requests[1]!.init.headers["X-Polaris-Delivery"]).toBe(deliveries[1]!.id);
    });

    it("refuses somebody else's delivery", async () => {
        await addHook();
        await queueOutboundHooks("u1", PAYLOAD);
        expect(await redeliverOutbound("u2", deliveries[0]!.id)).toEqual({ error: "notFound" });
    });
});

describe("the log", () => {
    it("pages newest first by cursor", async () => {
        const { id } = await addHook();
        for (let i = 0; i < 5; i++) await queueOutboundHooks("u1", PAYLOAD);
        const first = await listOutboundDeliveries("u1", id, null, 2);
        expect(first.items).toHaveLength(2);
        const second = await listOutboundDeliveries("u1", id, first.nextCursor, 2);
        const third = await listOutboundDeliveries("u1", id, second.nextCursor, 2);
        expect(third.items).toHaveLength(1);
        expect(third.nextCursor).toBeNull();
        const ids = [...first.items, ...second.items, ...third.items].map((d) => d.id);
        expect(ids).toEqual([...ids].sort().reverse());
        expect((await listOutboundDeliveries("u2", id, null)).items).toHaveLength(0);
    });

    it("drops rows older than thirty days on the background pass", async () => {
        await addHook();
        await queueOutboundHooks("u1", PAYLOAD);
        deliveries[0]!.createdAt = new Date(Date.now() - 31 * 24 * 3600_000);
        await queueOutboundHooks("u1", PAYLOAD);
        const result = await runOutboundHooks();
        expect(result.pruned).toBe(1);
        expect(deliveries).toHaveLength(1);
    });

    it("sends what is due on the background pass", async () => {
        await addHook();
        respond = async () => ({ status: 500 });
        await queueOutboundHooks("u1", PAYLOAD);
        respond = async () => ({ status: 204 });
        const later = new Date(Date.now() + RETRY_DELAYS_MS[0] + 1000);
        expect(await runOutboundHooks(later)).toMatchObject({ attempted: 1 });
        expect(deliveries[0]!.status).toBe("sent");
    });
});

describe("limits", () => {
    it("keeps at most twenty endpoints per account", async () => {
        for (let i = 0; i < 20; i++) await addHook();
        expect(
            await createOutboundHook("u1", {
                name: "x",
                url: "https://a.test/",
                events: ["deploy.failed"]
            })
        ).toEqual({
            error: "limit"
        });
    });

    it("refuses a private address", async () => {
        expect(
            await createOutboundHook("u1", {
                name: "x",
                url: "http://10.0.0.1/",
                events: ["deploy.failed"]
            })
        ).toEqual({
            error: "unreachable"
        });
    });

    it("rate-limits create, test and redeliver", async () => {
        const { id } = await addHook();
        allowRate = false;
        expect(await addHook().catch((error: Error) => error.message)).toBe("rateLimited");
        expect(
            await testOutboundHook("u1", id, { level: "info", title: "t", body: null, url: null })
        ).toEqual({
            error: "rateLimited"
        });
        expect(await redeliverOutbound("u1", "x")).toEqual({ error: "rateLimited" });
    });
});

describe("extra headers and sign-in", () => {
    const sentHeaders = () => requests[requests.length - 1]!.init.headers;

    it("sends a Bearer token and the extra headers, beside an unchanged signature", async () => {
        const { id, secret } = await addHook();
        const saved = await setOutboundHookRequest("u1", id, {
            auth: { type: "bearer", token: "tok_live_123" },
            headers: [
                { name: "X-Team", secret: false, value: "ops" },
                { name: "X-Api-Key", secret: true, value: "key_456" }
            ]
        });
        expect("hook" in saved).toBe(true);
        await queueOutboundHooks("u1", PAYLOAD);
        const headers = sentHeaders();
        expect(headers.Authorization).toBe("Bearer tok_live_123");
        expect(headers["X-Team"]).toBe("ops");
        expect(headers["X-Api-Key"]).toBe("key_456");
        const timestamp = Number(headers["X-Polaris-Timestamp"]);
        const body = requests[0]!.init.body;
        const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
        expect(headers["X-Polaris-Signature"]).toBe(`sha256=${expected}`);
    });

    it("sends Basic as base64 of user:password", async () => {
        const { id } = await addHook();
        await setOutboundHookRequest("u1", id, {
            auth: { type: "basic", username: "ana", password: "s3cret" },
            headers: []
        });
        await queueOutboundHooks("u1", PAYLOAD);
        expect(sentHeaders().Authorization).toBe(
            `Basic ${Buffer.from("ana:s3cret").toString("base64")}`
        );
    });

    it("sends a custom auth header by its own name", async () => {
        const { id } = await addHook();
        await setOutboundHookRequest("u1", id, {
            auth: { type: "header", name: "X-Auth-Token", value: "abc" },
            headers: []
        });
        await queueOutboundHooks("u1", PAYLOAD);
        expect(sentHeaders()["X-Auth-Token"]).toBe("abc");
        expect(sentHeaders().Authorization).toBeUndefined();
    });

    it("never returns a secret, and keeps the stored one when it is left out", async () => {
        const { id } = await addHook();
        await setOutboundHookRequest("u1", id, {
            auth: { type: "bearer", token: "tok_live_123" },
            headers: [{ name: "X-Api-Key", secret: true, value: "key_456" }]
        });
        const resaved = await setOutboundHookRequest("u1", id, {
            auth: { type: "bearer" },
            headers: [{ name: "X-Api-Key", secret: true }]
        });
        const listed = await listOutboundHooks("u1");
        for (const shown of [JSON.stringify(resaved), JSON.stringify(listed)]) {
            expect(shown).not.toContain("tok_live_123");
            expect(shown).not.toContain("key_456");
        }
        expect(listed[0]!.request).toEqual({
            auth: { type: "bearer", tokenSet: true },
            headers: [{ name: "X-Api-Key", secret: true, value: null, set: true }]
        });
        // Stored encrypted, not in the shown half.
        expect(JSON.stringify(hooks[0]!.requestConfig)).not.toContain("tok_live_123");
        await queueOutboundHooks("u1", PAYLOAD);
        expect(sentHeaders().Authorization).toBe("Bearer tok_live_123");
        expect(sentHeaders()["X-Api-Key"]).toBe("key_456");
    });

    it("refuses a secret left out that was never stored", async () => {
        const { id } = await addHook();
        expect(
            await setOutboundHookRequest("u1", id, { auth: { type: "bearer" }, headers: [] })
        ).toEqual({ error: "missingSecret" });
    });

    it("clears the sign-in and the headers when set back to none", async () => {
        const { id } = await addHook();
        await setOutboundHookRequest("u1", id, {
            auth: { type: "bearer", token: "tok_live_123" },
            headers: [{ name: "X-Team", secret: false, value: "ops" }]
        });
        await setOutboundHookRequest("u1", id, { auth: { type: "none" }, headers: [] });
        expect(hooks[0]!.encryptedRequest).toBeNull();
        await queueOutboundHooks("u1", PAYLOAD);
        expect(sentHeaders().Authorization).toBeUndefined();
        expect(sentHeaders()["X-Team"]).toBeUndefined();
    });

    it("never lets a stored row displace Polaris's own headers", async () => {
        const { id } = await addHook();
        const row = hooks.find((hook) => hook.id === id)!;
        row.requestConfig = {
            auth: { type: "none" },
            headers: [
                { name: "X-Polaris-Signature", secret: false, value: "sha256=forged" },
                { name: "Host", secret: false, value: "evil.test" },
                { name: "X-Split", secret: false, value: "a\r\nX-Injected: 1" }
            ]
        };
        await queueOutboundHooks("u1", PAYLOAD);
        const headers = sentHeaders();
        expect(headers["X-Polaris-Signature"]).not.toBe("sha256=forged");
        expect(headers.Host).toBeUndefined();
        expect(headers["X-Split"]).toBeUndefined();
    });

    it("does not touch another account's endpoint", async () => {
        const { id } = await addHook();
        expect(
            await setOutboundHookRequest("u2", id, { auth: { type: "none" }, headers: [] })
        ).toEqual({ error: "notFound" });
    });
});
