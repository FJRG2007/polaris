/**
 * The deploy-hook gateway: a request is only acted on when it is signed with the
 * hook's secret, is no more than five minutes off, has not been seen before, and
 * the account that made the hook may still deploy the service.
 */

import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const HOOK_ID = "00000000-0000-7000-8000-0000000000aa";
const APP_ID = "00000000-0000-7000-8000-0000000000bb";
const SECRET = "whsec_fixture_secret";
const enc = new TextEncoder();

let hook: { id: string; userId: string; applicationId: string; enabled: boolean } | null;
let receipts: Array<{ id: string; hookId: string; deliveryId: string; expiresAt: Date }>;
let hasPermission = true;
let projectAccessOk = true;
let rateOk = true;
const deploy = vi.fn(async (..._args: unknown[]) => "dep-1");

vi.mock("@polaris/db", () => ({
    prisma: {
        inboundWebhook: {
            findUnique: async () =>
                hook && {
                    ...hook,
                    encryptedSecret: enc.encode(SECRET),
                    secretNonce: new Uint8Array([1]),
                    secretKeyId: "k"
                },
            update: async () => ({})
        },
        inboundWebhookReceipt: {
            create: async ({
                data
            }: {
                data: { hookId: string; deliveryId: string; expiresAt: Date };
            }) => {
                if (
                    receipts.some(
                        (r) => r.hookId === data.hookId && r.deliveryId === data.deliveryId
                    )
                ) {
                    throw Object.assign(new Error("unique"), { code: "P2002" });
                }
                const row = { ...data, id: `r-${receipts.length + 1}` };
                receipts.push(row);
                return row;
            },
            deleteMany: async ({ where }: { where: { id?: string; expiresAt?: { lt: Date } } }) => {
                const before = receipts.length;
                receipts = receipts.filter((r) =>
                    where.id ? r.id !== where.id : r.expiresAt >= where.expiresAt!.lt
                );
                return { count: before - receipts.length };
            }
        },
        user: { findUnique: async () => ({ isAdmin: false }) }
    }
}));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "k" }) }));
vi.mock("@polaris/storage", () => ({
    encryptSecret: () => ({ ciphertext: new Uint8Array(), nonce: new Uint8Array(), keyId: "k" }),
    decryptSecret: (blob: { ciphertext: Uint8Array }) => new TextDecoder().decode(blob.ciphertext)
}));
vi.mock("@polaris/auth", () => ({ userHasPermission: async () => hasPermission }));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async () => ({ ok: rateOk, retryAfterMs: 0 })
}));
vi.mock("@/lib/deploy-project-access", () => ({
    requireApplicationAccess: async () => {
        if (!projectAccessOk) throw new Error("Service not found");
        return { ownerId: "owner-1", projectId: "p", environmentId: "e" };
    },
    visibleProjectIds: async () => [],
    projectAccess: async () => null,
    accessCan: () => true,
    accessInEnvironment: () => true
}));
vi.mock("@/lib/deploy-service", () => ({
    deployApplication: (...args: unknown[]) => deploy(...args)
}));
vi.mock("@/lib/notifications/outbound-hooks", () => ({
    newSigningSecret: () => SECRET,
    signPayload: (secret: string, ts: number, body: string) =>
        `sha256=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`
}));

const { receiveInbound, pruneInboundReceipts } = await import("../../src/lib/deploy/inbound-hooks");

function signed(body: string, opts: { ts?: number; delivery?: string; secret?: string } = {}) {
    const ts = opts.ts ?? Math.floor(Date.now() / 1000);
    const signature = `sha256=${createHmac("sha256", opts.secret ?? SECRET)
        .update(`${ts}.${body}`)
        .digest("hex")}`;
    return {
        id: HOOK_ID,
        ip: "203.0.113.5",
        headers: { delivery: opts.delivery ?? "d-1", timestamp: String(ts), signature },
        body
    };
}

beforeEach(() => {
    hook = { id: HOOK_ID, userId: "creator-1", applicationId: APP_ID, enabled: true };
    receipts = [];
    hasPermission = true;
    projectAccessOk = true;
    rateOk = true;
    deploy.mockClear();
});

describe("the deploy-hook gateway", () => {
    it("redeploys as the hook's creator, on the project owner's resources", async () => {
        expect(await receiveInbound(signed('{"ref":"main"}'))).toEqual({
            status: 202,
            deploymentId: "dep-1"
        });
        expect(deploy).toHaveBeenCalledWith(APP_ID, "owner-1", "creator-1");
    });

    it("refuses a wrong signature, and a body changed after signing", async () => {
        expect((await receiveInbound(signed("{}", { secret: "whsec_other" }))).status).toBe(401);
        const request = signed("{}");
        expect((await receiveInbound({ ...request, body: '{"x":1}' })).status).toBe(401);
        expect(deploy).not.toHaveBeenCalled();
    });

    it("refuses a timestamp more than five minutes off, either way", async () => {
        const now = Math.floor(Date.now() / 1000);
        expect((await receiveInbound(signed("{}", { ts: now - 301 }))).status).toBe(401);
        expect(
            (await receiveInbound(signed("{}", { ts: now + 301, delivery: "d-2" }))).status
        ).toBe(401);
        expect(
            (await receiveInbound(signed("{}", { ts: now - 299, delivery: "d-3" }))).status
        ).toBe(202);
    });

    it("refuses the same request twice", async () => {
        const request = signed("{}");
        expect((await receiveInbound(request)).status).toBe(202);
        expect((await receiveInbound(request)).status).toBe(409);
        expect(deploy).toHaveBeenCalledTimes(1);
    });

    it("refuses a signed request replayed under a new delivery id", async () => {
        const ts = Math.floor(Date.now() / 1000);
        expect((await receiveInbound(signed("{}", { ts, delivery: "d-1" }))).status).toBe(202);
        expect((await receiveInbound(signed("{}", { ts, delivery: "d-other" }))).status).toBe(409);
        expect(deploy).toHaveBeenCalledTimes(1);
    });

    it("lets a request be retried when the deploy did not start", async () => {
        deploy.mockRejectedValueOnce(new Error("daemon down"));
        const request = signed("{}");
        await expect(receiveInbound(request)).rejects.toThrow("daemon down");
        expect(await receiveInbound(request)).toEqual({ status: 202, deploymentId: "dep-1" });
    });

    it("forgets delivery ids once they could no longer pass", async () => {
        await receiveInbound(signed("{}"));
        expect(await pruneInboundReceipts(new Date(Date.now() + 11 * 60_000))).toBe(1);
    });

    it("stops working when the creator loses the deploy permission or the project", async () => {
        hasPermission = false;
        expect((await receiveInbound(signed("{}", { delivery: "a" }))).status).toBe(403);
        hasPermission = true;
        projectAccessOk = false;
        expect((await receiveInbound(signed("{}", { delivery: "b" }))).status).toBe(403);
        expect(deploy).not.toHaveBeenCalled();
    });

    it("answers a disabled or unknown hook as it answers a bad signature", async () => {
        hook!.enabled = false;
        expect((await receiveInbound(signed("{}"))).status).toBe(401);
        hook = null;
        expect((await receiveInbound(signed("{}", { delivery: "z" }))).status).toBe(401);
    });

    it("rejects missing headers, a malformed id, an oversized body, and a flood", async () => {
        expect(
            (
                await receiveInbound({
                    ...signed("{}"),
                    headers: { delivery: null, timestamp: null, signature: null }
                })
            ).status
        ).toBe(400);
        expect((await receiveInbound({ ...signed("{}"), id: "not-a-uuid" })).status).toBe(404);
        expect((await receiveInbound(signed("x".repeat(64 * 1024 + 1)))).status).toBe(413);
        rateOk = false;
        expect((await receiveInbound(signed("{}"))).status).toBe(429);
    });
});
