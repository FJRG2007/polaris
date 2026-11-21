/**
 * The pieces of an iPhone ring that do not need Apple: the provider token, the
 * body, which answers mean a phone is gone, and what the operator may paste.
 */

import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, verify } from "node:crypto";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/integration-service", () => ({
    getIntegrationState: vi.fn(async () => null),
    getIntegrationSecret: vi.fn(async () => null)
}));
vi.mock("@/lib/domain-service", () => ({ publicAppUrl: vi.fn(async () => null) }));

const push = await import("@/lib/mobile/voip-push");

const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const p8 = ec.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function part(token: string, index: number): Record<string, unknown> {
    return JSON.parse(Buffer.from(token.split(".")[index]!, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("the provider token", () => {
    it("is ES256, names the key and the team, and verifies with the key's public half", () => {
        const now = Date.UTC(2026, 10, 21, 12, 0, 0);
        const token = push.apnsJwt({ keyId: "ABC123DEFG", teamId: "XYZ987WVUT" }, p8, now);
        expect(part(token, 0)).toEqual({ alg: "ES256", kid: "ABC123DEFG" });
        expect(part(token, 1)).toEqual({ iss: "XYZ987WVUT", iat: now / 1000 });
        const [header, claims, signature] = token.split(".");
        const ok = verify(
            "sha256",
            Buffer.from(`${header}.${claims}`),
            { key: ec.publicKey, dsaEncoding: "ieee-p1363" },
            Buffer.from(signature!, "base64url")
        );
        expect(ok).toBe(true);
        // A raw r||s signature, as Apple wants it, not DER.
        expect(Buffer.from(signature!, "base64url")).toHaveLength(64);
    });
});

describe("the body", () => {
    it("carries what the call screen and the answer need, and nothing else", () => {
        const body = JSON.parse(
            push.voipPayload({ channelId: "c1", meetingId: "m1", caller: "Ana" }, "https://polaris.example")
        );
        expect(body).toEqual({
            kind: "call",
            origin: "https://polaris.example",
            channelId: "c1",
            meetingId: "m1",
            caller: "Ana",
            tag: "call:c1",
            path: "/chat/c/c1"
        });
    });
});

describe("a phone that is gone", () => {
    it("is one Apple says no longer has the app, never one that merely failed", () => {
        expect(push.tokenGone(410, "Unregistered")).toBe(true);
        expect(push.tokenGone(400, "BadDeviceToken")).toBe(true);
        expect(push.tokenGone(400, "DeviceTokenNotForTopic")).toBe(true);
        expect(push.tokenGone(400, "BadTopic")).toBe(false);
        expect(push.tokenGone(403, "InvalidProviderToken")).toBe(false);
        expect(push.tokenGone(429, "TooManyRequests")).toBe(false);
        expect(push.tokenGone(0, undefined)).toBe(false);
    });
});

describe("what the operator pastes", () => {
    it("takes Apple's key file and refuses anything else", () => {
        expect(push.validApnsKey(p8)).toBe(true);
        expect(push.validApnsKey(`  ${p8}\n`)).toBe(true);
        const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 });
        expect(push.validApnsKey(rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString())).toBe(false);
        expect(push.validApnsKey("not a key")).toBe(false);
        expect(push.validApnsKey("")).toBe(false);
    });

    it("checks the identifiers against Apple's shapes", () => {
        const good = { keyId: "ABC123DEFG", teamId: "XYZ987WVUT", bundleId: "app.polaris.mobile", sandbox: false };
        expect(push.applePushConfigSchema.safeParse(good).success).toBe(true);
        expect(push.applePushConfigSchema.safeParse({ ...good, keyId: "short" }).success).toBe(false);
        expect(push.applePushConfigSchema.safeParse({ ...good, teamId: "abc123defg" }).success).toBe(false);
        expect(push.applePushConfigSchema.safeParse({ ...good, bundleId: "nodots" }).success).toBe(false);
        expect(push.applePushConfigSchema.safeParse({ ...good, bundleId: "app/../x" }).success).toBe(false);
    });

    it("takes PushKit's hex token in either case, and nothing that could leave the path", () => {
        const hex = "a".repeat(64);
        expect(push.voipTokenSchema.parse({ token: hex.toUpperCase() }).token).toBe(hex);
        expect(push.voipTokenSchema.safeParse({ token: "../../3/device" }).success).toBe(false);
        expect(push.voipTokenSchema.safeParse({ token: "abc" }).success).toBe(false);
    });
});

describe("with no key set up", () => {
    it("rings nothing and asks nobody", async () => {
        await expect(push.ringIphones(["u1"], { channelId: "c1", meetingId: "m1", caller: "Ana" })).resolves.toBeUndefined();
    });
});
