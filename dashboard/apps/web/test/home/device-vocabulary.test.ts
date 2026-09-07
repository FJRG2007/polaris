/**
 * The pieces of the devices feature that are worth checking without a lock.
 *
 * Somebody else's numbers turned into this app's words, and a month of
 * timestamps counted into the days they fall in. Both are pure, both are where a
 * mistake is silent - a state read as "locked" when it is not is a screen saying
 * a door is shut - and neither needs an account, a network or a database.
 */

import { describe, expect, it } from "vitest";
import { translateLog } from "@/lib/home/drivers/nuki-web";
import { actionsFor, bucketUsage, describeEvent, settledState, USAGE_DAYS } from "@/lib/home/device-kinds";

/** One entry as Nuki hands it over. */
function entry(over: Partial<Parameters<typeof translateLog>[0]> = {}) {
    return {
        id: "log-1",
        action: 1,
        trigger: 255,
        state: 0,
        date: "2026-09-01T08:30:00.000Z",
        ...over
    };
}

describe("an entry from the account's log", () => {
    it("keeps the vendor's id, which is what stops a re-read writing it twice", () => {
        expect(translateLog(entry()).externalId).toBe("log-1");
    });

    it("reads an unlock on the keypad as one", () => {
        const line = translateLog(entry({ action: 1, trigger: 255, name: "Ada" }));
        expect(line.action).toBe("unlock");
        expect(line.via).toBe("keypad");
        expect(line.actor).toBe("Ada");
        expect(line.outcome).toBe("ok");
    });

    it("says why a door did not move, rather than dropping the attempt", () => {
        const line = translateLog(entry({ action: 2, state: 1 }));
        expect(line.outcome).toBe("failed");
        expect(line.note).toBe("the motor was blocked");
        expect(describeEvent({ ...blank, ...line, note: line.note ?? "" })).toContain(
            "the motor was blocked"
        );
    });

    it("keeps an action it has no word for rather than losing it from the history", () => {
        // A gap in a door's history is worse than a vague line in it.
        expect(translateLog(entry({ action: 243 })).action).toBe("other");
    });

    it("calls an automatic unlock automatic, whatever the trigger said", () => {
        expect(translateLog(entry({ autoUnlock: true, trigger: 5 })).via).toBe("auto");
    });

    it("refuses a date it cannot read rather than writing an invalid one", () => {
        expect(Number.isNaN(translateLog(entry({ date: "not a date" })).at.getTime())).toBe(false);
    });
});

/** The fields `describeEvent` needs that a translated line does not carry. */
const blank = {
    id: "e1",
    deviceId: "d1",
    deviceName: "Front door",
    actor: "",
    via: "system",
    outcome: "ok",
    note: "",
    at: "2026-09-01T08:30:00.000Z"
};

describe("a month of use, counted into days", () => {
    it("has a bucket for every day, including the empty ones", () => {
        const days = bucketUsage([], "UTC", USAGE_DAYS, Date.parse("2026-09-07T12:00:00Z"));
        expect(days).toHaveLength(USAGE_DAYS);
        expect(days.every((day) => day.count === 0)).toBe(true);
    });

    it("counts a time into the day it happened on", () => {
        const now = Date.parse("2026-09-07T12:00:00Z");
        const days = bucketUsage(
            [Date.parse("2026-09-07T09:00:00Z"), Date.parse("2026-09-07T11:00:00Z")],
            "UTC",
            USAGE_DAYS,
            now
        );
        expect(days[days.length - 1]?.count).toBe(2);
    });

    it("drops what is older than the window rather than piling it onto the first day", () => {
        const now = Date.parse("2026-09-07T12:00:00Z");
        const days = bucketUsage([Date.parse("2026-01-01T09:00:00Z")], "UTC", USAGE_DAYS, now);
        expect(days.reduce((total, day) => total + day.count, 0)).toBe(0);
    });

    it("keeps the days a day apart across a daylight saving change", () => {
        // Madrid loses an hour on the last Sunday of October. Subtracting
        // twenty-four hours thirty times would be an hour out by the end of the
        // window, and eventually a whole day out.
        const days = bucketUsage([], "Europe/Madrid", 10, Date.parse("2026-11-02T12:00:00Z"));
        const gaps = days.slice(1).map((day, index) => day.t - (days[index]?.t ?? 0));
        expect(gaps).toContain(25 * 60 * 60 * 1000);
        expect(new Set(gaps).size).toBe(2);
    });
});

describe("the buttons a kind of device gets", () => {
    it("gives a lock the bolt and the latch", () => {
        expect(actionsFor("lock")).toEqual(["lock", "unlock", "unlatch"]);
    });

    it("gives an opener only the one thing it can do", () => {
        // There is no bolt in a door opener. A "Lock" on it would be a button
        // that cannot do what it says.
        expect(actionsFor("opener")).toEqual(["unlatch"]);
    });

    it("gives a socket on and off, and no lock", () => {
        expect(actionsFor("outlet")).toEqual(["turn-on", "turn-off"]);
        expect(actionsFor("outlet")).not.toContain("lock");
    });

    it("reads a kind it does not know as a lock rather than as nothing", () => {
        // A device synced by a newer build and read by an older one. It draws,
        // and the service refuses the controls it should not have.
        expect(actionsFor("thermostat")).toEqual(["lock", "unlock", "unlatch"]);
    });

    it("knows where a switch ends up and leaves a turning lock to report itself", () => {
        expect(settledState("turn-on")).toBe("on");
        expect(settledState("turn-off")).toBe("off");
        expect(settledState("lock")).toBeNull();
    });

    it("writes a switch into the history in words rather than in codes", () => {
        const line = describeEvent({
            id: "e1",
            deviceId: "d1",
            deviceName: "Desk lamp",
            action: "turn-on",
            actor: "Ada",
            via: "polaris",
            outcome: "ok",
            note: "",
            at: "2026-09-01T08:30:00.000Z"
        });
        expect(line).toBe("Turned on by Ada from Polaris");
    });
});
