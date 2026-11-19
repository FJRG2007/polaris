/**
 * View-once files: the challenge, the phone's signature, and the one open.
 */

import { generateKeyPairSync, sign } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const keys = new Map<string, { id: string; userId: string }>();
const opens = new Set<string>();

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_AUTH_SECRET: "test-secret-test-secret-test-secret" }) }));
vi.mock("@polaris/db", () => {
    class PrismaClientKnownRequestError extends Error {
        constructor(readonly code: string) {
            super(code);
        }
    }
    return {
        Prisma: { PrismaClientKnownRequestError },
        prisma: {
            mobileDeviceKey: {
                findUnique: async ({ where }: { where: { publicKey: string } }) => keys.get(where.publicKey) ?? null,
                update: async () => ({})
            },
            chatAttachmentOpen: {
                create: async ({ data }: { data: { attachmentId: string; userId: string } }) => {
                    const key = `${data.attachmentId}:${data.userId}`;
                    if (opens.has(key)) throw new PrismaClientKnownRequestError("P2002");
                    opens.add(key);
                    return data;
                }
            }
        }
    };
});

const once = await import("@/lib/chat/view-once");
const choice = await import("@/lib/chat/view-once-choice");

const FILE = "0190f5e2-7c1a-7b3e-9a4d-2f6b8c1d0e9a";

function phone() {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64");
    return {
        spki,
        sign: (text: string) => sign("sha256", Buffer.from(text), privateKey).toString("base64")
    };
}

const file = (authorId = "sender") =>
    ({
        id: FILE,
        name: "a.jpg",
        contentType: "image/jpeg",
        connectionId: null,
        path: "x",
        viewSeconds: 10,
        message: { id: "m1", channelId: "c1", authorId }
    }) as const;

beforeEach(() => {
    keys.clear();
    opens.clear();
});

describe("challenges", () => {
    it("holds for exactly one reader, one file and one minute", () => {
        const now = 1_800_000_000_000;
        const challenge = once.viewOnceChallenge(FILE, "me", now);
        expect(once.challengeValid(challenge, FILE, "me", now + 59_000)).toBe(true);
        expect(once.challengeValid(challenge, FILE, "me", now + 61_000)).toBe(false);
        expect(once.challengeValid(challenge, FILE, "someone-else", now)).toBe(false);
        expect(once.challengeValid(challenge, "another-file", "me", now)).toBe(false);
        expect(once.challengeValid(`${challenge}x`, FILE, "me", now)).toBe(false);
        expect(once.challengeValid("garbage", FILE, "me", now)).toBe(false);
    });
});

describe("the phone's key", () => {
    it("accepts a P-256 key and its signature, and nothing else", () => {
        const device = phone();
        expect(once.readDeviceKey(device.spki)).not.toBeNull();
        expect(once.signatureValid(device.spki, "hello", device.sign("hello"))).toBe(true);
        expect(once.signatureValid(device.spki, "hello", device.sign("other"))).toBe(false);
        const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
        expect(once.readDeviceKey(rsa.export({ format: "der", type: "spki" }).toString("base64"))).toBeNull();
        expect(once.readDeviceKey("not a key")).toBeNull();
    });
});

describe("opening", () => {
    async function attempt(device: ReturnType<typeof phone>, userId = "me", target = file()) {
        const challenge = once.viewOnceChallenge(FILE, userId);
        return once.claimViewOnce(userId, target, {
            challenge,
            publicKey: device.spki,
            signature: device.sign(once.signedText(FILE, challenge))
        });
    }

    it("opens once on a registered phone, and refuses the second time", async () => {
        const device = phone();
        keys.set(device.spki, { id: "k1", userId: "me" });
        await expect(attempt(device)).resolves.toBeUndefined();
        await expect(attempt(device)).rejects.toMatchObject({ reason: "opened" });
    });

    it("refuses a phone nobody registered, or registered to somebody else", async () => {
        const device = phone();
        await expect(attempt(device)).rejects.toMatchObject({ reason: "device" });
        keys.set(device.spki, { id: "k1", userId: "someone-else" });
        await expect(attempt(device)).rejects.toMatchObject({ reason: "device" });
        expect(opens.size).toBe(0);
    });

    it("refuses a signature from another key, and the sender's own file", async () => {
        const device = phone();
        const other = phone();
        keys.set(device.spki, { id: "k1", userId: "me" });
        const challenge = once.viewOnceChallenge(FILE, "me");
        await expect(
            once.claimViewOnce("me", file(), {
                challenge,
                publicKey: device.spki,
                signature: other.sign(once.signedText(FILE, challenge))
            })
        ).rejects.toMatchObject({ reason: "signature" });
        await expect(attempt(device, "me", file("me"))).rejects.toMatchObject({ reason: "own" });
        expect(opens.size).toBe(0);
    });
});

describe("what a sender may choose", () => {
    it("reads only well-formed choices with an offered timer", () => {
        expect(choice.readViewOnceChoices(JSON.stringify([{ index: 0, seconds: 10, captured: "camera" }]))).toEqual([
            { index: 0, seconds: 10, captured: "camera" }
        ]);
        expect(choice.readViewOnceChoices(JSON.stringify([{ index: 0, seconds: null }]))).toEqual([
            { index: 0, seconds: null }
        ]);
        expect(choice.readViewOnceChoices(JSON.stringify([{ index: 0, seconds: 7 }]))).toEqual([]);
        expect(choice.readViewOnceChoices("{")).toEqual([]);
        expect(choice.readViewOnceChoices(null)).toEqual([]);
        expect(choice.viewOnceable("image/png")).toBe(true);
        expect(choice.viewOnceable("video/mp4")).toBe(true);
        expect(choice.viewOnceable("application/pdf")).toBe(false);
    });

    it("believes where a file came from only from the phone app", () => {
        expect(once.fromPhoneApp("Mozilla/5.0 PolarisMobile/0.1.2 (Android)")).toBe(true);
        expect(once.fromPhoneApp("Mozilla/5.0 Chrome/130")).toBe(false);
        expect(once.fromPhoneApp(null)).toBe(false);
    });
});
