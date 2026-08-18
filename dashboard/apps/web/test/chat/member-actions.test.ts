/**
 * What the roster offers about one person.
 *
 * These are rules rather than markup, and each of them fails in a way nobody
 * notices from the code: an item that quietly appears where it should not is an
 * administrator banning somebody out of a group that has no door, and one that
 * quietly disappears is a room nobody can moderate with no explanation on
 * screen.
 *
 * Two are decisions rather than consequences and are worth reading as such. A
 * group cannot ban, because a group is people who arrived by invitation from
 * somebody already in it - taking somebody out is the whole of it. And inviting
 * is the one thing shown when it cannot be done, because "why can I not invite
 * anybody" deserves answering where it is asked rather than by the absence of a
 * menu item.
 */

import { describe, expect, it } from "vitest";
import { memberActions, type InvitableSpace, type MemberRoom } from "@/app/(app)/chat/member-actions";

const ME = "me";
const THEM = "them";

const channel: MemberRoom = {
    id: "c1",
    kind: "text",
    spaceId: "s1",
    ownerId: null,
    mayModerate: false
};
const group: MemberRoom = {
    id: "g1",
    kind: "group",
    spaceId: null,
    ownerId: ME,
    mayModerate: false
};
const direct: MemberRoom = {
    id: "d1",
    kind: "dm",
    spaceId: null,
    ownerId: null,
    mayModerate: false
};

const spaces: readonly InvitableSpace[] = [
    { id: "s1", name: "Mine", archived: false, access: "owner" },
    { id: "s2", name: "Also mine", archived: false, access: "admin" },
    { id: "s3", name: "Somebody else's", archived: false, access: "member" },
    { id: "s4", name: "Closed", archived: true, access: "owner" }
];

const about = (memberId: string, room: MemberRoom) =>
    memberActions({ memberId, viewerId: ME, room, spaces });

describe("your own row", () => {
    it("offers nothing at all", () => {
        // Every item here reads oddly aimed at yourself, and two of them -
        // removing and banning - are ways to lock yourself out of your own room.
        const may = about(ME, channel);
        expect(may.any).toBe(false);
        expect(may.reach).toBe(false);
        expect(may.moderate).toBe(false);
        expect(may.transfer).toBe(false);
        expect(may.invitable).toEqual([]);
    });
});

describe("reaching somebody", () => {
    it("is offered about anybody else, in any kind of room", () => {
        for (const room of [channel, group, direct]) {
            expect(about(THEM, room).reach).toBe(true);
        }
    });
});

describe("inviting them somewhere", () => {
    it("offers the servers this reader runs", () => {
        expect(about(THEM, channel).invitable.map((entry) => entry.id)).toEqual(["s1", "s2"]);
    });

    it("leaves out one they are only a member of", () => {
        // Adding somebody to a space is an administrator's act. Offering it and
        // then being refused by the server is the worst of both.
        expect(about(THEM, channel).invitable.some((entry) => entry.id === "s3")).toBe(false);
    });

    it("leaves out an archived one", () => {
        expect(about(THEM, channel).invitable.some((entry) => entry.id === "s4")).toBe(false);
    });

    it("comes back empty rather than absent when there is nowhere", () => {
        // Empty is what the menu draws disabled. The distinction matters: the
        // item is shown precisely so that somebody who runs no servers is told
        // that is the reason.
        const may = memberActions({ memberId: THEM, viewerId: ME, room: channel, spaces: [] });
        expect(may.invitable).toEqual([]);
        expect(may.any).toBe(true);
    });
});

describe("moderating", () => {
    it("is offered to somebody who may moderate the room", () => {
        expect(about(THEM, { ...channel, mayModerate: true }).moderate).toBe(true);
    });

    it("is not offered to an ordinary member", () => {
        expect(about(THEM, channel).moderate).toBe(false);
    });

    it("is offered to whoever runs a group, which has no roles to hold it", () => {
        expect(about(THEM, group).moderate).toBe(true);
    });

    it("is not offered in somebody else's group", () => {
        expect(about(THEM, { ...group, ownerId: THEM }).moderate).toBe(false);
    });
});

describe("banning", () => {
    it("exists in a server", () => {
        expect(about(THEM, channel).ban).toBe(true);
    });

    it("does not exist in a group", () => {
        // The decision, not an oversight: a group has no door to stand at, so a
        // ban would be a lock on a room with no walls. Removing is the whole of
        // what can be done, and an invitation is the way back.
        expect(about(THEM, group).ban).toBe(false);
    });

    it("does not exist in a direct message", () => {
        expect(about(THEM, direct).ban).toBe(false);
    });
});

describe("handing a group over", () => {
    it("is offered to the owner of one", () => {
        expect(about(THEM, group).transfer).toBe(true);
    });

    it("is not offered by anybody else in it", () => {
        expect(about(THEM, { ...group, ownerId: THEM }).transfer).toBe(false);
    });

    it("is not offered in a channel, which belongs to its space", () => {
        expect(about(THEM, { ...channel, mayModerate: true }).transfer).toBe(false);
    });
});

describe("which room it is", () => {
    it("says a server when there is one, so removing says the right word", () => {
        expect(about(THEM, channel).space).toBe(true);
        expect(about(THEM, group).space).toBe(false);
    });
});
