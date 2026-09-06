/**
 * Who may ring somebody.
 *
 * A call is the loudest thing one account can do to another: it takes over the
 * screen of whatever they were doing and makes a noise in the room they are in.
 * So it starts at friends rather than at everybody, the way a file transfer
 * does and for the same reason.
 *
 * The line this holds is the one between ringing a PERSON and opening a ROOM. A
 * group or a channel is a room somebody walked into, and who may be in it is the
 * room's own question - making it depend on the settings of whoever happens to
 * be sitting in it would let one member close a channel to everybody else.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let audience = "friends";
let friends: string[] = [];
let colleagues = false;

vi.mock("@polaris/db", () => ({
    prisma: {
        userPrivacy: {
            findMany: async () => [{ userId: "them", calls: audience }]
        },
        organizationMember: { findMany: async () => (colleagues ? [{ userId: "them" }] : []) },
        organization: { findMany: async () => [] }
    }
}));

vi.mock("@/lib/friends-service", () => ({ friendIds: async () => new Set(friends) }));
vi.mock("@/lib/setting-store", () => ({
    getSetting: async () => null,
    setSetting: async () => undefined
}));
vi.mock("@/lib/orgs/org-service", () => ({
    memberOrgIds: async () => (colleagues ? ["org-1"] : [])
}));

const { mayRing } = await import("@/lib/privacy-service");

const me = { id: "me", isAdmin: false };

beforeEach(() => {
    audience = "friends";
    friends = [];
    colleagues = false;
});

describe("ringing somebody", () => {
    it("is refused by default for a stranger", async () => {
        expect(await mayRing(me, "them")).toBe(false);
    });

    it("is allowed for a friend", async () => {
        friends = ["them"];
        expect(await mayRing(me, "them")).toBe(true);
    });

    it("is allowed by anybody once they open it", async () => {
        audience = "everyone";
        expect(await mayRing(me, "them")).toBe(true);
    });

    // An account that says nobody means nobody, including the people it works
    // with. That is the one answer the colleague rule may not widen.
    it("is refused by everybody when they say nobody", async () => {
        audience = "nobody";
        friends = ["them"];
        colleagues = true;
        expect(await mayRing(me, "them")).toBe(false);
    });

    // Being put in one organization is somebody with authority over both
    // accounts saying they work together, which is a stronger statement than a
    // friend request.
    it("counts a colleague as a friend", async () => {
        colleagues = true;
        expect(await mayRing(me, "them")).toBe(true);
    });

    it("never stops somebody reaching their own other devices", async () => {
        audience = "nobody";
        expect(await mayRing(me, "me")).toBe(true);
    });

    it("does not stand in an administrator's way", async () => {
        audience = "nobody";
        expect(await mayRing({ id: "root", isAdmin: true }, "them")).toBe(true);
    });
});
