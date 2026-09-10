/**
 * The events route's guard and the rule ceiling.
 *
 * The signature is the only credential the route has, so what it accepts is
 * pinned: the body signed with the key, whichever of the HMAC hashes the engine
 * used, and nothing else. Then the flood guard: one rule, one window, twenty
 * notifications.
 */

import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const notify = vi.fn(async () => undefined);
const rules: Record<string, unknown>[] = [];
const server = {
    id: "0190f1c2-0000-7000-8000-000000000001",
    ownerId: "owner-1",
    orgId: null,
    hostname: "mail.example.com",
    hookSecret: Buffer.from("x"),
    hookSecretNonce: Buffer.from("x"),
    hookSecretKeyId: "k"
};

vi.mock("@/lib/notifications/dispatch", () => ({ notify }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock("@/lib/mail-server/access", () => ({
    MailServerAccessError: class extends Error {},
    unseal: () => "hook-secret"
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        mailServer: {
            findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
                where.id === server.id ? server : null
            )
        },
        mailInboundRule: {
            findMany: vi.fn(async () => rules.filter((rule) => rule.enabled)),
            findUnique: vi.fn(
                async ({ where }: { where: { id: string } }) =>
                    rules.find((rule) => rule.id === where.id) ?? null
            ),
            update: vi.fn(
                async ({
                    where,
                    data
                }: {
                    where: { id: string };
                    data: Record<string, unknown>;
                }) => {
                    const rule = rules.find((entry) => entry.id === where.id);
                    if (rule) Object.assign(rule, data);
                    return rule;
                }
            )
        }
    }
}));

const inbound = await import("@/lib/mail-server/inbound");

function signed(
    body: unknown,
    key = "hook-secret",
    algorithm = "sha256"
): { raw: Buffer; signature: string } {
    const raw = Buffer.from(JSON.stringify(body));
    return { raw, signature: createHmac(algorithm, key).update(raw).digest("base64") };
}

const ingest = (from: string, to: string[]) => ({
    events: [{ id: "1", type: "message-ingest.ham", data: { from, to } }]
});

beforeEach(() => {
    notify.mockClear();
    rules.length = 0;
    rules.push({
        id: "rule-1",
        serverId: server.id,
        name: "Invoices",
        recipient: "billing@*",
        sender: "",
        includeSpam: false,
        enabled: true,
        lastFiredAt: null,
        windowStartedAt: null,
        windowCount: 0,
        createdAt: new Date()
    });
});

describe("the signature", () => {
    it("accepts the body signed with the key, whichever hash signed it", () => {
        const { raw, signature } = signed({ events: [] });
        expect(inbound.signatureMatches(raw, signature, "hook-secret")).toBe(true);
        const sha512 = signed({ events: [] }, "hook-secret", "sha512");
        expect(inbound.signatureMatches(sha512.raw, sha512.signature, "hook-secret")).toBe(true);
    });

    it("refuses another key, a changed body, and no signature at all", () => {
        const { raw, signature } = signed({ events: [] }, "someone-else");
        expect(inbound.signatureMatches(raw, signature, "hook-secret")).toBe(false);
        const good = signed({ events: [] });
        expect(
            inbound.signatureMatches(Buffer.from('{"events":[1]}'), good.signature, "hook-secret")
        ).toBe(false);
        expect(inbound.signatureMatches(good.raw, null, "hook-secret")).toBe(false);
        expect(inbound.signatureMatches(good.raw, "not base64 of a digest", "hook-secret")).toBe(
            false
        );
    });

    it("answers a bad signature and an unknown server the same way", async () => {
        const { raw } = signed(ingest("a@b.test", ["billing@example.com"]));
        expect(await inbound.receiveEvents(server.id, raw, "AAAA")).toBe(401);
        expect(
            await inbound.receiveEvents("0190f1c2-0000-7000-8000-00000000ffff", raw, "AAAA")
        ).toBe(401);
    });

    it("refuses a signed body that is not the engine's", async () => {
        const { raw, signature } = signed({ hello: "world" });
        expect(await inbound.receiveEvents(server.id, raw, signature)).toBe(400);
    });
});

describe("a matching message", () => {
    it("notifies the server's owner", async () => {
        const { raw, signature } = signed(ingest("alerts@bank.test", ["billing@example.com"]));
        expect(await inbound.receiveEvents(server.id, raw, signature)).toBe(200);
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0]?.[0]).toMatchObject({
            userId: "owner-1",
            event: "mailserver.inbound"
        });
    });

    it("does not notify for another address, or for the server's own system mail", async () => {
        const other = signed(ingest("alerts@bank.test", ["sales@example.com"]));
        await inbound.receiveEvents(server.id, other.raw, other.signature);
        const own = signed(ingest("polaris@example.com", ["billing@example.com"]));
        await inbound.receiveEvents(server.id, own.raw, own.signature);
        expect(notify).not.toHaveBeenCalled();
    });

    it("stops notifying past twenty in one window", async () => {
        const events = Array.from({ length: 30 }, (_, index) => ({
            id: String(index),
            type: "message-ingest.ham",
            data: { from: `sender${index}@bank.test`, to: ["billing@example.com"] }
        }));
        const { raw, signature } = signed({ events });
        await inbound.receiveEvents(server.id, raw, signature);
        expect(notify).toHaveBeenCalledTimes(20);
    });
});

describe("the ceiling on its own", () => {
    it("starts a new window once the last one is ten minutes old", () => {
        const now = Date.now();
        expect(inbound.withinCeiling({ windowStartedAt: null, windowCount: 0 }, now)).toMatchObject(
            { allowed: true, fresh: true }
        );
        expect(
            inbound.withinCeiling({ windowStartedAt: new Date(now - 60_000), windowCount: 20 }, now)
                .allowed
        ).toBe(false);
        expect(
            inbound.withinCeiling(
                { windowStartedAt: new Date(now - 11 * 60_000), windowCount: 99 },
                now
            )
        ).toMatchObject({
            allowed: true,
            windowCount: 1
        });
    });
});
