import { describe, expect, it } from "vitest";
import { dmKeyFor, dmKeyOrgId } from "@polaris/core";

/**
 * The key is the whole of an organization keeping its own chat.
 *
 * A one-to-one conversation is found by it, so two call sites that build it
 * differently do not disagree - they make a second conversation and split
 * somebody's history in half. These pin the three properties the rest of it
 * rests on: it does not matter who asks, the same pair in two chats are two
 * conversations, and a key can always say which chat it belongs to.
 */
describe("the key a one-to-one conversation is found by", () => {
    const ann = "0199a000-0000-7000-8000-000000000001";
    const bob = "0199a000-0000-7000-8000-000000000002";
    const acme = "0199b000-0000-7000-8000-00000000000a";

    it("does not depend on who started it", () => {
        expect(dmKeyFor([ann, bob])).toBe(dmKeyFor([bob, ann]));
        expect(dmKeyFor([ann, bob], acme)).toBe(dmKeyFor([bob, ann], acme));
    });

    it("gives the same two people one conversation per chat", () => {
        expect(dmKeyFor([ann, bob], acme)).not.toBe(dmKeyFor([ann, bob]));
    });

    it("names nobody twice", () => {
        expect(dmKeyFor([ann, bob, ann])).toBe(dmKeyFor([ann, bob]));
    });

    it("says which chat it belongs to", () => {
        expect(dmKeyOrgId(dmKeyFor([ann, bob], acme))).toBe(acme);
        expect(dmKeyOrgId(dmKeyFor([ann, bob]))).toBeNull();
    });

    it("cannot mistake an account for an organization", () => {
        // The prefix is a word, and every id here is a uuid, so a key written
        // before any of this existed can never read as a scoped one.
        expect(dmKeyOrgId(`${ann}:${bob}`)).toBeNull();
    });
});
