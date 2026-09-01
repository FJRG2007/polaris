/**
 * A guest in a call, and the faces of the people they are in it with.
 *
 * The avatar route is signed in only, for good reasons: an open one confirms
 * which accounts exist and hands over a photo to whoever asks. A guest on a call
 * link has no session at all, so every face in the room came back 401 and drew
 * initials - one call, photographs for the people with accounts and grey circles
 * for the person who followed the link, which is the opposite of "a guest is in
 * the same room, not a lesser copy of it".
 *
 * Opening it to a guest is the kind of change that goes wrong quietly, so the
 * refusals are what this file is mostly about: the seat has to be admitted rather
 * than waiting at the door, and it only covers the people in that same call. A
 * guest link that could be turned into a face lookup for the whole instance would
 * be a worse bug than the one being fixed.
 *
 * The second reader with no session is somebody on a published profile, and the
 * two must not be confused: a guest is answered by the guest rules and by
 * nothing else, so a seat that is refused stays refused whatever the instance
 * publishes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Seat {
    meetingId: string;
    participantId: string;
    admission: "admitted" | "waiting" | "denied";
}

let session: { id: string; isAdmin: boolean } | null = null;
let seat: Seat | null = null;
/** Whether this instance shows profiles to people who are not signed in. */
let published = false;
/** Who is admitted to which call, as `inCallTogether` answers it. */
const room = new Map<string, Set<string>>([["m1", new Set(["ada"])]]);

const maySee = vi.fn(async (subjectId: string, _field: string, viewer: { id: string }) => {
    void subjectId;
    void _field;
    // Everything in these tests has a public picture except Grace, who keeps hers
    // for people she knows - which nobody signed out can be.
    return subjectId === "grace" ? viewer.id !== "" : true;
});

vi.mock("@/lib/session", () => ({ resolveSession: async () => session }));
vi.mock("@/lib/chat/meeting-seat", () => ({ resolveGuestSeat: async () => seat }));
vi.mock("@/lib/chat/meetings", () => ({
    inCallTogether: async (meetingId: string, userId: string) =>
        room.get(meetingId)?.has(userId) === true
}));
vi.mock("@/lib/privacy-service", () => ({ maySee }));
vi.mock("@/lib/profile-service", () => ({ profilesArePublic: async () => published }));
vi.mock("@/lib/avatar-service", () => ({
    resolveAvatar: async () => ({
        certain: true,
        picture: {
            etag: '"face"',
            mime: "image/png",
            load: async () => Buffer.from([1, 2, 3])
        }
    })
}));

const { GET } = await import("@/app/api/avatar/[userId]/route");
const { BLANK_AVATAR_ETAG } = await import("@/lib/avatar-blank");

/** Ask for one account's face, as whoever the state above says is asking. */
async function ask(userId: string): Promise<Response> {
    return GET(new Request(`http://polaris.test/api/avatar/${userId}`), {
        params: Promise.resolve({ userId })
    });
}

beforeEach(() => {
    session = null;
    seat = { meetingId: "m1", participantId: "p-guest", admission: "admitted" };
    published = false;
    maySee.mockClear();
});

describe("a guest sitting in the call", () => {
    it("is served the face of somebody admitted to the same call", async () => {
        const answer = await ask("ada");
        expect(answer.status).toBe(200);
        expect(answer.headers.get("Content-Type")).toBe("image/png");
    });

    it("asks as nobody, so only a picture meant for everybody reaches them", async () => {
        room.set("m1", new Set(["ada", "grace"]));
        const answer = await ask("grace");
        // The blank pixel rather than a refusal, so the initials show through and
        // nothing tells the asker there was a photo to be had.
        expect(answer.status).toBe(200);
        expect(answer.headers.get("ETag")).toBe(BLANK_AVATAR_ETAG);
        expect(maySee).toHaveBeenCalledWith("grace", "avatar", { id: "", isAdmin: false });
        room.set("m1", new Set(["ada"]));
    });

    it("is refused the face of somebody who is not in the call", async () => {
        expect((await ask("hopper")).status).toBe(401);
    });

    it("is refused while still waiting at the door", async () => {
        seat = { meetingId: "m1", participantId: "p-guest", admission: "waiting" };
        expect((await ask("ada")).status).toBe(401);
    });

    it("is refused once the seat is gone", async () => {
        seat = null;
        expect((await ask("ada")).status).toBe(401);
    });
});

describe("nobody at all", () => {
    it("is refused while this instance keeps its profiles behind the login", async () => {
        seat = null;
        expect((await ask("ada")).status).toBe(401);
    });

    it("asks as nobody once profiles are published, so only a public face reaches them", async () => {
        seat = null;
        published = true;
        const answer = await ask("ada");
        expect(answer.status).toBe(200);
        expect(maySee).toHaveBeenCalledWith("ada", "avatar", { id: "", isAdmin: false });
    });

    it("still gets the blank pixel for a face its owner keeps back", async () => {
        seat = null;
        published = true;
        const answer = await ask("grace");
        expect(answer.status).toBe(200);
        expect(answer.headers.get("ETag")).toBe(BLANK_AVATAR_ETAG);
    });
});

describe("a refused seat", () => {
    it("stays refused even where profiles are published", async () => {
        // The guest rules answer, and they answer no. Falling through to the
        // published-profile rule would make a waiting seat wider than an
        // admitted one is.
        seat = { meetingId: "m1", participantId: "p-guest", admission: "waiting" };
        published = true;
        expect((await ask("ada")).status).toBe(401);
    });
});

describe("an account", () => {
    it("asks as itself, whatever call it is or is not in", async () => {
        session = { id: "grace", isAdmin: false };
        seat = null;
        const answer = await ask("hopper");
        expect(answer.status).toBe(200);
        expect(maySee).toHaveBeenCalledWith("hopper", "avatar", { id: "grace", isAdmin: false });
    });
});
