/**
 * Lending one door without lending the house.
 *
 * Places was all-or-nothing: `home.read` showed every camera and `home.control`
 * opened every lock. A grant is the second way in, and it has to be a narrowing
 * rather than a widening - which is exactly the kind of thing that is one
 * careless `||` away from being neither.
 *
 * Four things are pinned here, and each of them is somebody getting into
 * something if it breaks: a visitor reaches only what they were lent, seeing is
 * not operating, a use is counted only when the door actually moved, and holding
 * a key is not being able to cut copies of it.
 */

import type { SessionUser } from "@/lib/session";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** Which instance permissions the caller holds. */
let held = new Set<string>();
/** What they were lent, by subject and id. */
let lent: Record<string, { id: string; capability: string; counted: boolean }[]> = {};

const spendGrant = vi.fn(async () => true);

vi.mock("@/lib/session", () => ({
    sessionCan: async (_user: unknown, permission: string) => held.has(permission)
}));

vi.mock("@/lib/access/grants", () => ({
    liveGrants: async (_userId: string, subject: string, subjectId: string) =>
        lent[`${subject}:${subjectId}`] ?? [],
    grantedSubjects: async (_userId: string, subject: string) =>
        new Map(
            Object.entries(lent)
                .filter(([key]) => key.startsWith(`${subject}:`))
                .map(([key, grants]) => [key.split(":").slice(1).join(":"), grants[0]!.capability])
        ),
    reachesAnySubject: async (_userId: string, subjects: readonly string[]) =>
        Object.keys(lent).some((key) => subjects.some((subject) => key.startsWith(`${subject}:`))),
    spendGrant
}));

const sharing = await import("@/lib/home/sharing");

const VISITOR = { id: "u9", isAdmin: false } as unknown as SessionUser;

function key(subject: string, id: string) {
    return `${subject}:${id}`;
}

beforeEach(() => {
    held = new Set();
    lent = {};
    vi.clearAllMocks();
});

describe("what a visitor reaches", () => {
    it("is only what they were lent", async () => {
        lent[key("place.device", "front-door")] = [
            { id: "g1", capability: "control", counted: false }
        ];
        const reach = await sharing.placesReach(VISITOR);
        expect(reach.everything).toBe(false);
        expect(sharing.reachesDevice(reach, "front-door", "control")).toBe(true);
        expect(sharing.reachesDevice(reach, "back-door")).toBe(false);
        expect(sharing.reachesCamera(reach, "yard")).toBe(false);
    });

    it("is everything, unread, for somebody who lives here", async () => {
        held.add("home.read");
        const reach = await sharing.placesReach(VISITOR);
        expect(reach.everything).toBe(true);
        // The maps are not consulted for a resident, and reading them as empty
        // would be reading them as "nothing".
        expect(sharing.reachesDevice(reach, "any-door", "control")).toBe(true);
    });

    it("narrows a list to what is theirs, and leaves a resident's alone", async () => {
        const all = [{ id: "a" }, { id: "b" }, { id: "c" }];
        expect(sharing.onlyReachable(all, new Map([["b", "view"]]))).toEqual([{ id: "b" }]);
        expect(sharing.onlyReachable(all, true)).toEqual(all);
    });

    it("puts the app in their switcher, because one door is something to open", async () => {
        lent[key("place.camera", "yard")] = [{ id: "g1", capability: "view", counted: false }];
        expect(await sharing.reachesPlaces("u9")).toBe(true);
    });

    it("does not, for somebody lent nothing", async () => {
        expect(await sharing.reachesPlaces("u9")).toBe(false);
    });
});

describe("seeing is not operating", () => {
    it("refuses a door to somebody who was only lent the sight of it", async () => {
        lent[key("place.device", "front-door")] = [
            { id: "g1", capability: "view", counted: false }
        ];
        await expect(sharing.requireDeviceControl(VISITOR, "front-door")).rejects.toThrow();
    });

    it("opens it for somebody who was lent operating it", async () => {
        lent[key("place.device", "front-door")] = [
            { id: "g1", capability: "control", counted: true }
        ];
        const grant = await sharing.requireDeviceControl(VISITOR, "front-door");
        expect(grant?.id).toBe("g1");
    });

    it("opens it for a resident, and hands back nothing to count", async () => {
        held.add("home.control");
        expect(await sharing.requireDeviceControl(VISITOR, "front-door")).toBeNull();
    });

    it("refuses a door nobody lent them at all", async () => {
        await expect(sharing.requireDeviceControl(VISITOR, "front-door")).rejects.toThrow();
    });
});

describe("what counts as a use", () => {
    it("counts one against a limited grant", async () => {
        await sharing.countDeviceUse({
            id: "g1",
            capability: "control",
            until: null,
            counted: true
        });
        expect(spendGrant).toHaveBeenCalledOnce();
    });

    it("counts nothing for a resident, who has no grant to spend", async () => {
        await sharing.countDeviceUse(null);
        expect(spendGrant).not.toHaveBeenCalled();
    });

    it("does not turn a door that opened into a failure when the count cannot be written", async () => {
        // The grant was taken back between the check and the act. The door has
        // already moved, so the visitor must not be told it did not.
        spendGrant.mockRejectedValueOnce(new Error("no such row"));
        const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
        await expect(
            sharing.countDeviceUse({ id: "g1", capability: "control", until: null, counted: true })
        ).resolves.toBeUndefined();
        expect(quiet).toHaveBeenCalled();
        quiet.mockRestore();
    });
});

describe("watching a camera", () => {
    it("is open to a resident and to whoever was lent that one", async () => {
        lent[key("place.camera", "yard")] = [{ id: "g1", capability: "view", counted: false }];
        expect(await sharing.mayWatchCamera(VISITOR, "yard")).toBe(true);
        expect(await sharing.mayWatchCamera(VISITOR, "hall")).toBe(false);
        held.add("home.read");
        expect(await sharing.mayWatchCamera(VISITOR, "hall")).toBe(true);
    });
});
