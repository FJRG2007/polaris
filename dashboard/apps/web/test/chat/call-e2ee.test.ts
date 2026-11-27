import * as e2ee from "@/lib/chat/call-e2ee";
import { describe, expect, it } from "vitest";

const room = "6f1c2d4e-0000-4000-8000-000000000001";

describe("which calls are encrypted", () => {
    it("encrypts every call except a stage's", () => {
        expect(e2ee.callEncrypted(false)).toBe(true);
        expect(e2ee.callEncrypted(true)).toBe(false);
    });

    it("refuses a client from before call encryption, never lets it in the clear", () => {
        expect(e2ee.callE2eeRefusal(false, undefined)).toBe("outdated");
        expect(e2ee.callE2eeRefusal(false, 0)).toBe("outdated");
        expect(e2ee.callE2eeRefusal(false, e2ee.CALL_E2EE_VERSION)).toBeNull();
        // A stage is not encrypted, so an old client may still listen in.
        expect(e2ee.callE2eeRefusal(true, undefined)).toBeNull();
    });
});

describe("the key leader and generations", () => {
    it("is the lowest identity", () => {
        expect(e2ee.keyLeader(["seat-b", "seat-a", "seat-c"])).toBe("seat-a");
        expect(e2ee.keyLeader([])).toBeNull();
    });

    it("keeps generations in the cryptor's key ring", () => {
        expect(e2ee.keySlot(1)).toBe(1);
        expect(e2ee.keySlot(e2ee.CALL_KEYRING_SIZE + 3)).toBe(3);
    });

    it("sees a join and a leave as a membership change, order as none", () => {
        const before = new Set(["a", "b"]);
        expect(e2ee.membershipChanged(null, before)).toBe(true);
        expect(e2ee.membershipChanged(before, new Set(["b", "a"]))).toBe(false);
        expect(e2ee.membershipChanged(before, new Set(["a", "b", "c"]))).toBe(true);
        expect(e2ee.membershipChanged(before, new Set(["a"]))).toBe(true);
        expect(e2ee.membershipChanged(before, new Set(["a", "c"]))).toBe(true);
    });
});

describe("wrapping a call key", () => {
    it("opens for its recipient, with and without the conversation's MLS secret", async () => {
        const leader = await e2ee.makeCallKeyPair();
        const bob = await e2ee.makeCallKeyPair();
        const key = e2ee.makeCallKey();
        for (const bind of [null, { epoch: "7", secret: new Uint8Array(32).fill(9) }]) {
            const message = await e2ee.wrapCallKey(key, leader.pair, leader.pub, bob.pub, { room, gen: 3, leader: "a", to: "b", bind });
            expect(e2ee.callKeyMessageSchema.safeParse(message).success).toBe(true);
            const opened = await e2ee.unwrapCallKey(message, bob.pair, { room, leader: "a", self: "b", bind });
            expect(opened).toEqual(key);
        }
    });

    it("does not open for anybody else, in another room, or under another MLS secret", async () => {
        const leader = await e2ee.makeCallKeyPair();
        const bob = await e2ee.makeCallKeyPair();
        const eve = await e2ee.makeCallKeyPair();
        const bind = { epoch: "7", secret: new Uint8Array(32).fill(9) };
        const message = await e2ee.wrapCallKey(e2ee.makeCallKey(), leader.pair, leader.pub, bob.pub, { room, gen: 1, leader: "a", to: "b", bind });
        expect(await e2ee.unwrapCallKey(message, eve.pair, { room, leader: "a", self: "b", bind })).toBeNull();
        expect(await e2ee.unwrapCallKey({ ...message, to: "e" }, eve.pair, { room, leader: "a", self: "e", bind })).toBeNull();
        expect(await e2ee.unwrapCallKey(message, bob.pair, { room: "other", leader: "a", self: "b", bind })).toBeNull();
        expect(await e2ee.unwrapCallKey(message, bob.pair, { room, leader: "z", self: "b", bind })).toBeNull();
        // A server that knows everything but the conversation's MLS secret.
        expect(
            await e2ee.unwrapCallKey(message, bob.pair, { room, leader: "a", self: "b", bind: { epoch: "7", secret: new Uint8Array(32) } })
        ).toBeNull();
        // Stripping the binding does not downgrade it either.
        expect(await e2ee.unwrapCallKey({ ...message, epoch: null }, bob.pair, { room, leader: "a", self: "b", bind: null })).toBeNull();
        const tampered = e2ee.fromBase64(message.wrapped);
        tampered[0] ^= 1;
        expect(
            await e2ee.unwrapCallKey({ ...message, wrapped: e2ee.toBase64(tampered) }, bob.pair, { room, leader: "a", self: "b", bind })
        ).toBeNull();
    });

    it("drops what does not fit the message shape", () => {
        expect(e2ee.readKeyMessage(new TextEncoder().encode("not json"))).toBeNull();
        expect(e2ee.readKeyMessage(new TextEncoder().encode(JSON.stringify({ v: 1, gen: 0 })))).toBeNull();
        expect(e2ee.readAnnounce('{"v":1,"pub":"AAAA","epoch":null}')).toEqual({ v: 1, pub: "AAAA", epoch: null });
        expect(e2ee.readAnnounce('{"v":2}')).toBeNull();
        expect(e2ee.readAnnounce(undefined)).toBeNull();
    });
});
