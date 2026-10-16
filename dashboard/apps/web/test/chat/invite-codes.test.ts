/**
 * Finding the invitations in a message, which is what decides whether a card
 * is drawn under it - for a link sent from the invite dialog and for one
 * somebody pasted by hand alike.
 */

import { describe, expect, it } from "vitest";
import { inviteCodesIn, spaceInviteAllowed } from "@polaris/core";

const origin = "https://polaris.example";

describe("invite codes in a message", () => {
    it("finds a link on this deployment, bare or inside Markdown", () => {
        expect(inviteCodesIn(`${origin}/chat/i/AbCdEf1234`, origin)).toEqual(["AbCdEf1234"]);
        expect(inviteCodesIn(`come in: [Join](${origin}/chat/i/AbCdEf1234)`, origin)).toEqual([
            "AbCdEf1234"
        ]);
        expect(inviteCodesIn("open /chat/i/AbCdEf1234 please", null)).toEqual(["AbCdEf1234"]);
    });

    it("ignores the same path on somebody else's site", () => {
        expect(inviteCodesIn("https://elsewhere.example/chat/i/AbCdEf1234", origin)).toEqual([]);
        expect(inviteCodesIn("https://elsewhere.example/chat/i/AbCdEf1234", null)).toEqual([]);
    });

    it("lists each code once, and no more than three", () => {
        const body = ["a1b2c3d4e5", "a1b2c3d4e5", "f6g7h8i9j0", "k1l2m3n4o5", "p6q7r8s9t0"]
            .map((code) => `${origin}/chat/i/${code}`)
            .join(" ");
        expect(inviteCodesIn(body, origin)).toEqual(["a1b2c3d4e5", "f6g7h8i9j0", "k1l2m3n4o5"]);
    });

    it("finds nothing in an ordinary message", () => {
        expect(inviteCodesIn("hello there", origin)).toEqual([]);
    });
});

describe("who may invite", () => {
    it("is anybody in an open space and only those who run a private one", () => {
        expect(spaceInviteAllowed("member", "internal")).toBe(true);
        expect(spaceInviteAllowed("member", "private")).toBe(false);
        expect(spaceInviteAllowed("admin", "private")).toBe(true);
        expect(spaceInviteAllowed("owner", "private")).toBe(true);
        expect(spaceInviteAllowed(null, "internal")).toBe(false);
    });
});
