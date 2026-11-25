/**
 * Sealed poll votes: a ballot opens only with its history key and its own
 * binding (conversation, epoch, poll, ballot id, voter); a public ballot moved
 * to another voter does not open; two anonymous ballots of one epoch never
 * share a key and nonce; and every ballot is the same size whatever it picks.
 */

import { describe, expect, it } from "vitest";
import * as content from "../src/message-content";

const HK = new Uint8Array(32).map((_, index) => index);
const BINDING = {
    conversationId: "0190a5b2-0000-7000-8000-000000000001",
    epoch: 7n,
    pollId: "0190a5b2-0000-7000-8000-0000000000aa",
    ballotId: "6f9c1a52-3c4e-4a41-9d1e-2b7f0c8e9a10",
    voter: "0190a5b2-0000-7000-8000-0000000000b1"
};
const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");

describe("sealed ballots", () => {
    it("round-trips the picks", async () => {
        const sealed = await content.sealBallot(HK, BINDING, content.encodeBallot([0, 3, 9]));
        expect(content.decodeBallot(await content.openBallot(HK, BINDING, sealed))).toEqual([0, 3, 9]);
        expect(content.decodeBallot(content.encodeBallot([]))).toEqual([]);
        expect(content.decodeBallot(content.encodeBallot([15]))).toEqual([15]);
    });

    it("is one size whatever it picks", async () => {
        const one = await content.sealBallot(HK, BINDING, content.encodeBallot([1]));
        const many = await content.sealBallot(HK, BINDING, content.encodeBallot([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
        expect(one).toHaveLength(content.SEALED_BALLOT_BYTES);
        expect(many).toHaveLength(content.SEALED_BALLOT_BYTES);
    });

    it("does not open under any other binding or key", async () => {
        const sealed = await content.sealBallot(HK, BINDING, content.encodeBallot([2]));
        const others = [
            { ...BINDING, conversationId: "0190a5b2-0000-7000-8000-000000000002" },
            { ...BINDING, epoch: 8n },
            { ...BINDING, pollId: "0190a5b2-0000-7000-8000-0000000000ab" },
            { ...BINDING, ballotId: "6f9c1a52-3c4e-4a41-9d1e-2b7f0c8e9a11" },
            // A public ballot handed to another voter's row, or passed off as anonymous.
            { ...BINDING, voter: "0190a5b2-0000-7000-8000-0000000000b2" },
            { ...BINDING, voter: null }
        ];
        for (const binding of others) await expect(content.openBallot(HK, binding, sealed)).rejects.toBeInstanceOf(content.MessageOpenError);
        await expect(content.openBallot(new Uint8Array(32), BINDING, sealed)).rejects.toBeInstanceOf(content.MessageOpenError);
        for (let at = 0; at < sealed.length; at += 1) {
            const flipped = sealed.slice();
            flipped[at] ^= 1;
            await expect(content.openBallot(HK, BINDING, flipped)).rejects.toBeInstanceOf(content.MessageOpenError);
        }
    });

    it("never opens as a message, nor a message as a ballot", async () => {
        const message = { conversationId: BINDING.conversationId, epoch: BINDING.epoch, messageId: BINDING.pollId, senderLeaf: 0 };
        const ballot = await content.sealBallot(HK, BINDING, content.encodeBallot([1]));
        await expect(content.openMessage(HK, message, ballot)).rejects.toBeInstanceOf(content.MessageOpenError);
        const sealed = await content.sealMessage(HK, message, content.encodeBallot([1]));
        await expect(content.openBallot(HK, BINDING, sealed)).rejects.toBeInstanceOf(content.MessageOpenError);
    });

    it("gives two anonymous ballots of one epoch different keys", async () => {
        const anonymous = { ...BINDING, voter: null };
        const first = await content.sealBallot(HK, anonymous, content.encodeBallot([1]));
        const second = await content.sealBallot(HK, { ...anonymous, ballotId: "6f9c1a52-3c4e-4a41-9d1e-2b7f0c8e9a12" }, content.encodeBallot([1]));
        expect(hex(first)).not.toBe(hex(second));
        expect(content.decodeBallot(await content.openBallot(HK, anonymous, first))).toEqual([1]);
    });

    it("refuses what is not a ballot", () => {
        expect(content.decodeBallot(new Uint8Array([2, 1, 0]))).toBeNull();
        expect(content.decodeBallot(new Uint8Array([1, 1]))).toBeNull();
        expect(() => content.encodeBallot([16])).toThrow(RangeError);
        expect(() => content.encodeBallot([-1])).toThrow(RangeError);
        expect(() => content.encodeBallot([1.5])).toThrow(RangeError);
    });
});
