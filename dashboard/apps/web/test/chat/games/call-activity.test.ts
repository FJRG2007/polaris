/**
 * Games in a call, as every browser works them out: who is playing, which
 * messages are believed, and what the frame is handed.
 */

import { describe, expect, it } from "vitest";
import * as activity from "@/lib/chat/call-activity";

/** A pass good until 2100, unless told otherwise. */
const claim = (game: string, at: number, expires = 4_102_444_800_000) => ({
    game,
    at,
    pass: `${expires}.sig`
});

describe("the session a call is playing", () => {
    it("is nobody's until somebody vouched for starts one", () => {
        const people = [{ seat: "a", claim: claim("new-york", 10) }];
        expect(activity.activitySession(people, new Set())).toBeNull();
        expect(activity.activitySession([{ seat: "a", claim: null }], new Set(["a"]))).toBeNull();
    });

    it("starts with the earliest claim, and players join it in order", () => {
        const people = [
            { seat: "c", claim: claim("new-york", 30) },
            { seat: "a", claim: claim("new-york", 10) },
            { seat: "b", claim: claim("new-york", 20) },
            { seat: "d", claim: null }
        ];
        expect(activity.activitySession(people, new Set(["a", "b", "c", "d"]))).toEqual({
            game: "new-york",
            startedBy: "a",
            players: ["a", "b", "c"]
        });
    });

    it("leaves out a claim the server did not vouch for", () => {
        const people = [
            { seat: "a", claim: claim("new-york", 10) },
            { seat: "x", claim: claim("new-york", 5) }
        ];
        expect(activity.activitySession(people, new Set(["a"]))?.players).toEqual(["a"]);
    });

    it("plays one game: a second started later is not part of it", () => {
        const people = [
            { seat: "a", claim: claim("new-york", 10) },
            { seat: "b", claim: claim("other", 11) }
        ];
        expect(activity.activitySession(people, new Set(["a", "b"]))).toEqual({
            game: "new-york",
            startedBy: "a",
            players: ["a"]
        });
    });

    it("forgets a player who leaves, and ends when the last one does", () => {
        const both = [
            { seat: "a", claim: claim("new-york", 10) },
            { seat: "b", claim: claim("new-york", 20) }
        ];
        const vouched = new Set(["a", "b"]);
        expect(activity.activitySession(both.slice(1), vouched)).toEqual({
            game: "new-york",
            startedBy: "b",
            players: ["b"]
        });
        expect(activity.activitySession([], vouched)).toBeNull();
    });

    it("is capped at the most players the frame draws", () => {
        const people = Array.from({ length: 40 }, (_, index) => ({
            seat: `s${index}`,
            claim: claim("new-york", index + 1)
        }));
        const session = activity.activitySession(
            people,
            new Set(people.map((person) => person.seat))
        );
        expect(session?.players).toHaveLength(activity.MAX_PLAYERS);
    });
});

describe("a pass that ran out", () => {
    it("stops counting, so a player who could not renew it leaves the game", () => {
        const people = [
            { seat: "a", claim: claim("new-york", 10, 2_000_000_000_000) },
            { seat: "b", claim: claim("new-york", 20, 1_000_000_000_000) }
        ];
        const vouched = new Set(["a", "b"]);
        expect(activity.activitySession(people, vouched, 900_000_000_000)?.players).toEqual([
            "a",
            "b"
        ]);
        expect(activity.activitySession(people, vouched, 1_000_000_000_000)?.players).toEqual([
            "a"
        ]);
        expect(activity.activitySession(people, vouched, 2_000_000_000_000)).toBeNull();
    });

    it("is read off the pass, and a pass that says nothing has run out", () => {
        expect(activity.passExpiresAt("1700000000000.sig")).toBe(1_700_000_000_000);
        expect(activity.passExpiresAt("soon.sig")).toBe(0);
        expect(activity.passExpiresAt("")).toBe(0);
    });

    it("lasts a few minutes, renewed well before it runs out", () => {
        expect(activity.PASS_TTL_MS).toBeLessThanOrEqual(10 * 60 * 1000);
        expect(activity.RENEW_BEFORE_MS).toBeLessThan(activity.PASS_TTL_MS);
    });
});

describe("a claim in an attribute", () => {
    it("round-trips, and empty is none", () => {
        const value = claim("new-york", 10);
        expect(activity.readClaim({ activity: activity.encodeClaim(value) })).toEqual(value);
        expect(activity.encodeClaim(null)).toBe("");
        expect(activity.readClaim({ activity: "" })).toBeNull();
        expect(activity.readClaim(undefined)).toBeNull();
    });

    it("is dropped when it is not JSON, has extra fields, or a bad game id", () => {
        expect(activity.readClaim({ activity: "{" })).toBeNull();
        expect(
            activity.readClaim({ activity: JSON.stringify({ ...claim("new-york", 1), x: 1 }) })
        ).toBeNull();
        expect(activity.readClaim({ activity: JSON.stringify(claim("../etc", 1)) })).toBeNull();
        expect(activity.readClaim({ activity: JSON.stringify(claim("new-york", -1)) })).toBeNull();
        expect(activity.readClaim({ activity: "x".repeat(500) })).toBeNull();
    });
});

const pose = { x: 1, y: 2, z: 3, heading: 0.5, mode: "car" as const };

describe("a message on the data channel", () => {
    it("is read only in its exact shape", () => {
        expect(activity.readActivityMessage({ kind: "pose", game: "new-york", pose })).toEqual({
            kind: "pose",
            game: "new-york",
            pose
        });
        for (const bad of [
            null,
            "pose",
            { kind: "other" },
            { kind: "pose", game: "new-york" },
            { kind: "pose", game: "new-york", pose: { ...pose, x: Number.NaN } },
            { kind: "pose", game: "new-york", pose: { ...pose, x: 1e9 } },
            { kind: "pose", game: "new-york", pose: { ...pose, mode: "tank" } },
            { kind: "pose", game: "new-york", pose: { ...pose, extra: 1 } },
            { kind: "pose", game: "new-york", pose, extra: 1 }
        ]) {
            expect(activity.readActivityMessage(bad)).toBeNull();
        }
    });

    it("is passed on only between players of the same game, and not in a flood", () => {
        const session = { game: "new-york", startedBy: "a", players: ["a", "b"] };
        const message = { kind: "pose" as const, game: "new-york", pose };
        expect(activity.acceptPose(session, "a", "b", message, undefined, 1000)).toBe(true);
        // From somebody not playing, to somebody not playing, about another game.
        expect(activity.acceptPose(session, "a", "c", message, undefined, 1000)).toBe(false);
        expect(activity.acceptPose(session, "c", "b", message, undefined, 1000)).toBe(false);
        expect(
            activity.acceptPose(session, "a", "b", { ...message, game: "other" }, undefined, 1000)
        ).toBe(false);
        expect(activity.acceptPose(null, "a", "b", message, undefined, 1000)).toBe(false);
        expect(activity.acceptPose(session, "a", "a", message, undefined, 1000)).toBe(false);
        // Too soon after the last one from the same seat.
        expect(activity.acceptPose(session, "a", "b", message, 990, 1000)).toBe(false);
        expect(activity.acceptPose(session, "a", "b", message, 900, 1000)).toBe(true);
    });
});

describe("a position from the game's frame", () => {
    it("is read as a pose, extra fields dropped", () => {
        expect(activity.readFramePose({ type: "polaris-game:state", ...pose, speed: 3 })).toEqual(
            pose
        );
    });

    it("keeps syncing after a player turned many times the same way", () => {
        const turned = activity.readFramePose({ ...pose, heading: 0.5 + 2 * Math.PI * 400 });
        expect(turned?.heading).toBeCloseTo(0.5, 6);
        expect(activity.readFramePose({ ...pose, heading: -1e9 })).not.toBeNull();
    });

    it("drops anything else", () => {
        for (const bad of [
            undefined,
            "pose",
            { ...pose, y: Infinity },
            { ...pose, heading: Number.NaN },
            { ...pose, mode: "boat" },
            { type: "polaris-game:join", self: { id: "a", name: "b" } }
        ]) {
            expect(activity.readFramePose(bad)).toBeNull();
        }
    });
});

describe("a heading", () => {
    it("is wrapped between -pi and pi", () => {
        for (const heading of [0, 3, -3, 7, -7, 1e6]) {
            const wrapped = activity.wrapHeading(heading);
            expect(wrapped).toBeGreaterThanOrEqual(-Math.PI);
            expect(wrapped).toBeLessThanOrEqual(Math.PI);
            expect(Math.cos(wrapped)).toBeCloseTo(Math.cos(heading), 9);
            expect(Math.sin(wrapped)).toBeCloseTo(Math.sin(heading), 9);
        }
    });
});

describe("the players handed to the frame", () => {
    it("are the others whose position is known, with names cut to size", () => {
        const session = { game: "new-york", startedBy: "a", players: ["a", "b", "c"] };
        const poses = new Map([
            ["a", pose],
            ["b", pose]
        ]);
        const players = activity.framePlayers(session, "a", poses, (seat) =>
            seat === "b" ? "n".repeat(90) : ""
        );
        expect(players).toEqual([{ id: "b", name: "n".repeat(64), ...pose }]);
    });
});
