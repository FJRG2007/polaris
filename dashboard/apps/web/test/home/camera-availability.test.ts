/**
 * Being told when a camera stops being there.
 *
 * Nothing else in Places reports this. Every other signal is driven by what a
 * camera saw, so a camera that has gone dark looks exactly like a quiet night -
 * the tile stops refreshing, the log simply ends, and the front door is
 * unwatched until somebody happens to look.
 *
 * The two things worth pinning are the wording and the waiting. The wording,
 * because the count is the whole diagnosis: everything at a place going at once
 * is the building - the power, the switch, the uplink - and one camera going
 * while its neighbours keep answering is that camera, which is the case somebody
 * should get out of bed for. The waiting, because an alert that fires on a
 * camera rebooting for a firmware check is one nobody reads on the night it
 * mattered.
 */

import { describe, expect, it } from "vitest";
import { notificationEvent, resolveRule } from "@polaris/core";
import { ALERT_KINDS, alertRuleInputSchema } from "@/lib/home/schemas";
import { OFFLINE_GRACE_MS, quietSince } from "@/lib/home/availability";
import { outageHeadline, outageLength } from "@/lib/home/reachability";

describe("how an outage is worded", () => {
    it("names the building when everything there went at once", () => {
        expect(outageHeadline("Front door", "Home", 4, 4)).toBe(
            "Every camera at Home stopped answering"
        );
    });

    it("says a camera is the odd one out when its neighbours are fine", () => {
        // The sentence that separates a power cut from a cut cable, which is the
        // only part of the diagnosis that is knowable from here.
        expect(outageHeadline("Front door", "Home", 1, 4)).toBe(
            "Front door stopped answering - the only one of 4 at Home"
        );
    });

    it("counts the ones in between rather than rounding to either", () => {
        expect(outageHeadline("Front door", "Home", 2, 5)).toBe(
            "Front door stopped answering - 2 of 5 at Home have"
        );
    });

    it("says it plainly for a place with one camera", () => {
        expect(outageHeadline("Front door", "Home", 1, 1)).toBe("Front door stopped answering");
    });

    it("leaves the place out when the camera is not in one", () => {
        expect(outageHeadline("Front door", "", 1, 1)).toBe("Front door stopped answering");
        expect(outageHeadline("Front door", "", 3, 3)).toBe("Every camera stopped answering");
    });
});

describe("how long it was gone", () => {
    const at = (ms: number) => new Date(1_800_000_000_000 + ms);

    it("counts in minutes, then hours, then days", () => {
        expect(outageLength(at(0), at(4 * 60_000))).toBe("4 minutes");
        expect(outageLength(at(0), at(60 * 60_000))).toBe("1 hour");
        expect(outageLength(at(0), at(5 * 60 * 60_000))).toBe("5 hours");
        expect(outageLength(at(0), at(3 * 24 * 60 * 60_000))).toBe("3 days");
    });

    it("never says nothing at all, however short the gap", () => {
        // A camera back inside the same pass still had an outage worth a length:
        // "it was quiet for 0 minutes" reads as a bug.
        expect(outageLength(at(0), at(1000))).toBe("1 minute");
    });
});

describe("how long a camera has to be quiet first", () => {
    const at = (ms: number) => new Date(1_800_000_000_000 + ms).toISOString();

    it("waits longer than a reboot and less than a night", () => {
        expect(OFFLINE_GRACE_MS).toBeGreaterThanOrEqual(60_000);
        expect(OFFLINE_GRACE_MS).toBeLessThanOrEqual(10 * 60_000);
    });

    it("says nothing about a camera that has only just missed a frame", () => {
        // The column is written on the first miss, which is a moment earlier
        // than anything a reader should be shown: a camera rebooting for a
        // firmware check must not turn a tile red on its way back.
        const now = 1_800_000_000_000 + OFFLINE_GRACE_MS;
        expect(quietSince(at(1), now)).toBeNull();
        expect(quietSince(at(0), now)?.getTime()).toBe(1_800_000_000_000);
    });

    it("says nothing at all about a camera that is answering", () => {
        expect(quietSince(null)).toBeNull();
        expect(quietSince("not a date")).toBeNull();
    });
});

describe("what somebody can ask to be told", () => {
    it("declares the event it raises, so the dispatcher does not refuse it", () => {
        expect(notificationEvent("places.offline")).not.toBeNull();
        expect(notificationEvent("places.offline")?.group).toBe("places");
    });

    it("leaves it on, unlike a sighting", () => {
        // A camera that stopped is not something a house reports all day, and it
        // is the one thing here nothing else would surface.
        expect(resolveRule({}, "places.offline").inapp).toBe(true);
    });

    it("can still be turned off, like everything else in Places", () => {
        expect(notificationEvent("places.offline")?.critical).toBeFalsy();
        const off = { inapp: false, email: false, destinations: [] };
        expect(resolveRule({ "places.offline": off }, "places.offline").inapp).toBe(false);
    });

    it("is a rule anybody can write", () => {
        expect(ALERT_KINDS).toContain("offline");
        const parsed = alertRuleInputSchema.safeParse({
            name: "The door went quiet",
            kinds: ["offline"],
            recipients: ["3f3a2b1c-1111-4222-8333-444455556666"]
        });
        expect(parsed.success).toBe(true);
    });
});
