/**
 * The QR sign-in carrying the chat account key (docs/chat-e2ee-phase1.md).
 *
 * The server's part is relay only: keep the new browser's offer, keep the
 * approving device's sealed key, hand it to the browser holding the device
 * code in the response that spends the code. What is pinned here:
 *
 * - flag off: the flow is the one it always was, down to the columns it reads
 *   and writes - an offer or a transfer sent anyway leaves no trace;
 * - flag on: a transfer is relayed only for an approval that passed the PIN,
 *   for a code that carried an offer, and in the name of the session that is
 *   answering; a malformed one never blocks the sign-in;
 * - delivered once, to the poll that spends the row; replayed, swapped and
 *   cross-delivered transfers (two sign-ins at once) open to nothing.
 */

import * as qr from "@polaris/chat-crypto/qr-approval";
import * as account from "@polaris/chat-crypto/account-key";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface DeviceRow {
    deviceCode: string;
    userCode: string;
    userId: string | null;
    status: string;
    expiresAt: Date;
    createdAt: Date;
    requestIp: string | null;
    requestUserAgent: string | null;
    requestHost: string | null;
    e2eeOffer?: Uint8Array | null;
    e2eeApproval?: string | null;
}

const OWNER = "11111111-1111-4111-8111-111111111111";
const PHONE = "33333333-3333-4333-8333-333333333333";
const OTHER_SESSION = "44444444-4444-4444-8444-444444444444";
const AK = new Uint8Array(32).map((_, index) => 200 - index);

let rows: DeviceRow[] = [];
let pinAccepted = true;
let opened: { deviceCode: string; userCode: string }[] = [];
let selects: Record<string, unknown>[] = [];
let updates: Record<string, unknown>[] = [];

vi.mock("next/headers", () => ({
    headers: async () => new Headers({ "x-forwarded-for": "203.0.113.9", "user-agent": "Mozilla/5.0 Chrome/140" }),
    cookies: async () => ({ set: () => undefined })
}));

function find(where: { userCode?: string; deviceCode?: string }): DeviceRow | undefined {
    return rows.find(
        (row) =>
            (where.userCode !== undefined && row.userCode === where.userCode) ||
            (where.deviceCode !== undefined && row.deviceCode === where.deviceCode)
    );
}

vi.mock("@polaris/db", () => ({
    prisma: {
        deviceCode: {
            findUnique: async ({ where, select }: { where: { userCode?: string; deviceCode?: string }; select: Record<string, unknown> }) => {
                selects.push(select);
                const row = find(where);
                if (!row) return null;
                return Object.fromEntries(Object.keys(select).map((key) => [key, row[key as keyof DeviceRow] ?? null]));
            },
            update: async ({ where, data }: { where: { userCode?: string; deviceCode?: string }; data: Record<string, unknown> }) => {
                updates.push(data);
                const row = find(where);
                if (row) Object.assign(row, data);
            },
            deleteMany: async () => ({ count: 0 })
        },
        session: { findMany: async () => [] },
        auditLog: { findMany: async () => [] }
    }
}));

vi.mock("@polaris/auth", () => ({
    openDeviceCode: async () => {
        const next = opened.shift()!;
        rows.push(waitingRow(next));
        return { ...next, expiresAt: new Date(Date.now() + 120_000), pollIntervalMs: 3000 };
    },
    claimDeviceCode: async (_auth: unknown, userCode: string) => {
        const row = find({ userCode });
        if (row) row.userId = OWNER;
        return true;
    },
    decideDeviceCode: async (_auth: unknown, userCode: string, approve: boolean) => {
        const row = find({ userCode });
        if (row) row.status = approve ? "approved" : "denied";
        return {};
    },
    // Spends the row, as the real flow does.
    exchangeDeviceCode: async (_auth: unknown, deviceCode: string) => {
        const row = find({ deviceCode });
        if (!row || row.status !== "approved") return { status: row ? "pending" : "expired", cookies: [] };
        rows = rows.filter((entry) => entry !== row);
        return { status: "approved" as const, cookies: [] };
    },
    beginSessionRotation: async () => undefined,
    getUserSecurity: async () => ({ hasPin: true }),
    noteSignInAuthorizer: async () => undefined,
    verifyQuickPin: async () => pinAccepted
}));

vi.mock("@/lib/auth", () => ({ auth: {} }));
vi.mock("@/lib/session-device", () => ({ sessionDeviceLabels: async () => new Map() }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/geo-service", () => ({ resolveGeo: async () => ({ countryCode: "ES" }) }));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: async () => "https://polaris.example.com" }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true, retryAfterMs: 0 }) }));
vi.mock("@/lib/chat/spam-restriction", () => ({
    spamRestrictionFor: async () => null,
    restrictionHoursLeft: () => 0
}));

const service = await import("../../../src/lib/qr-sign-in-service");
const { qrSignInDecisionSchema } = await import("@polaris/core");

function waitingRow(code: { deviceCode: string; userCode: string }): DeviceRow {
    return {
        ...code,
        userId: null,
        status: "pending",
        expiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
        requestIp: "203.0.113.9",
        requestUserAgent: "Mozilla/5.0 Chrome/140",
        requestHost: "polaris.example.com"
    };
}

function text(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64url");
}

/** The account's real published keys, as the verifier on the new browser sees them. */
async function verifier(): Promise<account.AccountKeyVerifier> {
    const published = await account.accountPublicKeys(AK);
    return { verify: async (userId, akVersion, keys) => userId === OWNER && akVersion === 1 && account.samePublicKeys(published, keys) };
}

/** The new browser: open a code with an offer, as the sign-in screen does. */
async function newBrowser(deviceCode: string, userCode: string) {
    opened.push({ deviceCode, userCode });
    const offer = await qr.createQrOffer();
    const result = await service.openSignInCode(text(offer.publicKey));
    const fragment = await qr.offerFragment(userCode, offer);
    return { offer, code: result.code!, fragment };
}

/** The approving phone: describe, seal for what it scanned, answer with the PIN. */
async function approve(userCode: string, fragment: string, bySession = PHONE, sealAs = PHONE) {
    const request = await service.describeSignInCode(userCode, OWNER);
    let keyTransfer: unknown;
    if (request?.keyOffer) {
        const approval = await qr.sealQrApproval({
            accountKey: AK,
            akVersion: 1,
            userId: OWNER,
            flowId: request.userCode,
            approverDeviceId: sealAs,
            offerPublicKey: new Uint8Array(Buffer.from(request.keyOffer, "base64url")),
            scanned: qr.readOfferFragment(fragment)!
        });
        keyTransfer = qr.encodeQrApproval(approval);
    }
    const decision = qrSignInDecisionSchema.parse({ userCode, approve: true, pin: "1234", keyTransfer });
    return service.decideSignInCode(OWNER, bySession, decision);
}

async function opensTo(offer: qr.QrOffer, delivery: service.QrKeyDelivery | null): Promise<Uint8Array | null> {
    if (!delivery) return null;
    try {
        const { accountKey } = await qr.openQrApproval({
            offer,
            flowId: delivery.flowId,
            userId: delivery.userId,
            approval: qr.decodeQrApproval(delivery.transfer),
            verifier: await verifier()
        });
        return accountKey;
    } catch {
        return null;
    }
}

beforeEach(() => {
    rows = [];
    pinAccepted = true;
    opened = [];
    selects = [];
    updates = [];
    delete process.env.POLARIS_INTERNAL_CHAT_E2EE;
});

describe("flag off: the QR sign-in is exactly what it was", () => {
    it("ignores an offer, exposes none, relays no transfer and reads the same columns", async () => {
        const { code, fragment, offer } = await newBrowser("device-a", "ABCD2345");
        expect(updates).toHaveLength(1);
        expect(updates[0]).not.toHaveProperty("e2eeOffer");
        expect(Object.keys(updates[0]!).sort()).toEqual(
            ["requestHost", "requestIp", "requestUserAgent", "requestUserAgentBrands", "requestUserAgentPlatform"].sort()
        );
        expect(code.url).not.toContain("#");

        const request = await service.describeSignInCode("ABCD2345", OWNER);
        expect(request).not.toHaveProperty("keyOffer");
        expect(selects.at(-1)).not.toHaveProperty("e2eeOffer");

        // A transfer sent anyway (a client on another version) is not stored.
        process.env.POLARIS_INTERNAL_CHAT_E2EE = "1";
        rows[0]!.e2eeOffer = offer.publicKey;
        const request2 = await service.describeSignInCode("ABCD2345", OWNER);
        const approval = await qr.sealQrApproval({
            accountKey: AK,
            akVersion: 1,
            userId: OWNER,
            flowId: "ABCD2345",
            approverDeviceId: PHONE,
            offerPublicKey: new Uint8Array(Buffer.from(request2!.keyOffer!, "base64url")),
            scanned: qr.readOfferFragment(fragment)!
        });
        delete process.env.POLARIS_INTERNAL_CHAT_E2EE;
        const decision = qrSignInDecisionSchema.parse({
            userCode: "ABCD2345",
            approve: true,
            pin: "1234",
            keyTransfer: qr.encodeQrApproval(approval)
        });
        updates = [];
        expect(await service.decideSignInCode(OWNER, PHONE, decision)).toEqual({});
        expect(updates).toEqual([]);
        expect(rows[0]!.e2eeApproval ?? null).toBeNull();

        selects = [];
        expect(await service.redeemSignInCodeWithKeys("device-a")).toEqual({ status: "approved", keys: null });
        expect(selects).toEqual([{ userId: true, status: true }]);
    });

    it("keeps the plain poll's answer and query whatever the flag says", async () => {
        process.env.POLARIS_INTERNAL_CHAT_E2EE = "1";
        rows = [{ ...waitingRow({ deviceCode: "device-a", userCode: "ABCD2345" }), status: "approved", userId: OWNER, e2eeApproval: "{}" }];
        expect(await service.redeemSignInCode("device-a")).toBe("approved");
        expect(selects).toEqual([{ userId: true, status: true }]);
    });
});

describe("flag on: the key rides the approval", () => {
    beforeEach(() => {
        process.env.POLARIS_INTERNAL_CHAT_E2EE = "1";
    });

    it("delivers AK to the browser that showed the QR, once, with its session", async () => {
        const { offer, fragment } = await newBrowser("device-a", "ABCD2345");
        expect(rows[0]!.e2eeOffer?.length).toBe(qr.QR_OFFER_PUBLIC_KEY_BYTES);
        expect(await approve("ABCD2345", fragment)).toEqual({});
        const first = await service.redeemSignInCodeWithKeys("device-a");
        expect(first.status).toBe("approved");
        expect(first.keys?.flowId).toBe("ABCD2345");
        expect(Array.from((await opensTo(offer, first.keys))!)).toEqual(Array.from(AK));
        // Spent with the code: a second poll gets nothing to replay.
        expect(await service.redeemSignInCodeWithKeys("device-a")).toEqual({ status: "expired", keys: null });
    });

    it("ignores a malformed offer rather than refusing to open the code", async () => {
        opened.push({ deviceCode: "device-a", userCode: "ABCD2345" });
        const result = await service.openSignInCode("not-a-key");
        expect(result.code).toBeDefined();
        expect(rows[0]!.e2eeOffer ?? null).toBeNull();
    });

    it("relays nothing for a wrong PIN, and the right PIN still works after", async () => {
        const { offer, fragment } = await newBrowser("device-a", "ABCD2345");
        pinAccepted = false;
        expect((await approve("ABCD2345", fragment)).error).toBeDefined();
        expect(rows[0]!.e2eeApproval ?? null).toBeNull();
        pinAccepted = true;
        expect(await approve("ABCD2345", fragment)).toEqual({});
        expect(await opensTo(offer, (await service.redeemSignInCodeWithKeys("device-a")).keys)).not.toBeNull();
    });

    it("refuses to relay a transfer sealed in another session's name", async () => {
        const { fragment } = await newBrowser("device-a", "ABCD2345");
        expect(await approve("ABCD2345", fragment, PHONE, OTHER_SESSION)).toEqual({});
        expect(rows[0]!.e2eeApproval ?? null).toBeNull();
        expect((await service.redeemSignInCodeWithKeys("device-a")).keys).toBeNull();
    });

    it("never lets a malformed transfer block the sign-in", () => {
        const parsed = qrSignInDecisionSchema.parse({
            userCode: "ABCD2345",
            approve: true,
            pin: "1234",
            keyTransfer: { envelope: "x" }
        });
        expect(parsed.keyTransfer).toBeUndefined();
        expect(parsed.approve).toBe(true);
    });

    it("hands a stored transfer that was tampered with to nobody who can open it", async () => {
        const { offer, fragment } = await newBrowser("device-a", "ABCD2345");
        await approve("ABCD2345", fragment);
        const stored = JSON.parse(rows[0]!.e2eeApproval!);
        const envelope = Buffer.from(stored.envelope, "base64url");
        envelope[envelope.length - 1]! ^= 1;
        rows[0]!.e2eeApproval = JSON.stringify({ ...stored, envelope: envelope.toString("base64url") });
        const { keys } = await service.redeemSignInCodeWithKeys("device-a");
        expect(keys).not.toBeNull();
        expect(await opensTo(offer, keys)).toBeNull();
    });

    it("keeps two sign-ins at once apart: neither browser opens the other's key", async () => {
        const one = await newBrowser("device-a", "ABCD2345");
        const two = await newBrowser("device-b", "WXYZ6789");
        await Promise.all([approve("ABCD2345", one.fragment), approve("WXYZ6789", two.fragment)]);
        const [first, second] = await Promise.all([
            service.redeemSignInCodeWithKeys("device-a"),
            service.redeemSignInCodeWithKeys("device-b")
        ]);
        expect(await opensTo(one.offer, first.keys)).not.toBeNull();
        expect(await opensTo(two.offer, second.keys)).not.toBeNull();
        // A server that swaps the deliveries gets two refusals.
        expect(await opensTo(one.offer, second.keys)).toBeNull();
        expect(await opensTo(two.offer, first.keys)).toBeNull();
    });

    it("seals nothing when the QR's commitment and the relayed offer disagree", async () => {
        const { fragment } = await newBrowser("device-a", "ABCD2345");
        // The server swaps the stored offer for a key of its own.
        rows[0]!.e2eeOffer = (await qr.createQrOffer()).publicKey;
        await expect(approve("ABCD2345", fragment)).rejects.toBeInstanceOf(qr.QrApprovalError);
    });
});
