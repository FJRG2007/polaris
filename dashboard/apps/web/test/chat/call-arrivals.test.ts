/**
 * Who walked into the call and who walked out.
 *
 * Two sources report it - the roster and the call server - and they disagree
 * about when: a closed tab leaves the call server at once and the roster only
 * once its seat is swept. What is pinned: each change is announced once,
 * whichever reported it first; this browser's own seat is never announced; and
 * a batch reads as one line.
 */

import { describe, expect, it } from "vitest";
import {
    arrivalNotice,
    fromMediaJoined,
    fromMediaLeft,
    fromRoster,
    startPresence
} from "@/app/(app)/chat/call-arrivals";

const roster = (...people: [string, string][]) => new Map(people);
const ME: [string, string] = ["seat-me", "Me"];
const ANA: [string, string] = ["seat-ana", "Ana"];
const BEA: [string, string] = ["seat-bea", "Bea"];

describe("the roster", () => {
    it("does not announce whoever was already here", () => {
        const start = startPresence(roster(ME, ANA));
        const change = fromRoster(start, roster(ME, ANA), "seat-me");
        expect(change.joined).toEqual([]);
        expect(change.left).toEqual([]);
    });

    it("announces somebody arriving and somebody leaving", () => {
        const start = startPresence(roster(ME, ANA));
        const arrived = fromRoster(start, roster(ME, ANA, BEA), "seat-me");
        expect(arrived.joined).toEqual(["Bea"]);
        const gone = fromRoster(arrived.state, roster(ME, BEA), "seat-me");
        expect(gone.left).toEqual(["Ana"]);
    });

    it("never announces this browser's own seat", () => {
        const start = startPresence(roster(ANA));
        expect(fromRoster(start, roster(ME, ANA), "seat-me").joined).toEqual([]);
        const inside = startPresence(roster(ME, ANA));
        expect(fromRoster(inside, roster(ANA), "seat-me").left).toEqual([]);
    });
});

describe("the call server first", () => {
    it("announces a leave at once, and not again when the roster catches up", () => {
        const start = startPresence(roster(ME, ANA));
        const dropped = fromMediaLeft(start, "seat-ana");
        expect(dropped.left).toEqual(["Ana"]);
        // The roster still lists her for a while: not an arrival.
        const stale = fromRoster(dropped.state, roster(ME, ANA), "seat-me");
        expect(stale.joined).toEqual([]);
        expect(stale.left).toEqual([]);
        // And when it drops her, she is not announced a second time.
        const swept = fromRoster(stale.state, roster(ME), "seat-me");
        expect(swept.left).toEqual([]);
        expect(swept.joined).toEqual([]);
    });

    it("announces a seat the call server took back", () => {
        const start = startPresence(roster(ME, ANA));
        const dropped = fromMediaLeft(start, "seat-ana");
        const back = fromMediaJoined(dropped.state, "seat-ana");
        expect(back.joined).toEqual(["Ana"]);
        expect(fromRoster(back.state, roster(ME, ANA), "seat-me").joined).toEqual([]);
    });

    it("ignores connections nobody announced - its own, or one not let in", () => {
        const start = startPresence(roster(ME, ANA));
        expect(fromMediaLeft(start, "recorder").left).toEqual([]);
        expect(fromMediaJoined(start, "seat-bea").joined).toEqual([]);
    });
});

describe("the toast", () => {
    it("names one person", () => {
        expect(arrivalNotice(["Ana"], [])).toEqual({ key: "joined", name: "Ana", others: 0 });
        expect(arrivalNotice([], ["Ana"])).toEqual({ key: "left", name: "Ana", others: 0 });
    });

    it("counts the rest of a batch", () => {
        expect(arrivalNotice(["Ana", "Bea", "Cy"], [])).toEqual({
            key: "joinedMany",
            name: "Ana",
            others: 2
        });
        expect(arrivalNotice([], ["Ana", "Bea"])).toEqual({
            key: "leftMany",
            name: "Ana",
            others: 1
        });
    });

    it("leads with arrivals, and says nothing for nothing", () => {
        expect(arrivalNotice(["Bea"], ["Ana"])?.key).toBe("joined");
        expect(arrivalNotice([], [])).toBeNull();
    });
});
