/**
 * When an unattended update runs.
 *
 * The rule under test is that a daily schedule is counted from the moment a build
 * became available, not from a calendar day: "every day at 05:00" has to mean the
 * first 05:00 after the build appeared, so one published at 02:00 installs the
 * same morning and one published at 07:00 waits for tomorrow rather than
 * installing straight away.
 *
 * The other half is that a schedule cannot be lost. A stored policy that no
 * longer parses falls back to the safe default (tell, install nothing) instead of
 * throwing, because the watcher reading it has no way to ask a person.
 */

import { describe, expect, it } from "vitest";
import {
    autoUpdateRunsAt,
    autoUpdatePolicySchema,
    DEFAULT_AUTO_UPDATE,
    nextDailyRun,
    parseAutoUpdatePolicy,
    parseUpdateSource,
    stringifyAutoUpdatePolicy,
    updateSourceSchema,
    type AutoUpdatePolicy
} from "../src/schemas/updates.js";

const daily = (at: string): AutoUpdatePolicy => ({ mode: "daily", at });

describe("auto-update policy", () => {
    it("refuses a time that is not a 24-hour clock", () => {
        expect(autoUpdatePolicySchema.safeParse(daily("05:00")).success).toBe(true);
        expect(autoUpdatePolicySchema.safeParse(daily("23:59")).success).toBe(true);
        expect(autoUpdatePolicySchema.safeParse(daily("24:00")).success).toBe(false);
        expect(autoUpdatePolicySchema.safeParse(daily("5:00")).success).toBe(false);
        expect(autoUpdatePolicySchema.safeParse(daily("05:60")).success).toBe(false);
        expect(autoUpdatePolicySchema.safeParse({ mode: "hourly", at: "05:00" }).success).toBe(false);
    });

    it("round-trips through storage", () => {
        const policy = daily("03:30");
        expect(parseAutoUpdatePolicy(stringifyAutoUpdatePolicy(policy))).toEqual(policy);
    });

    it("falls back to installing nothing when the stored policy cannot be read", () => {
        expect(parseAutoUpdatePolicy(null)).toEqual(DEFAULT_AUTO_UPDATE);
        expect(parseAutoUpdatePolicy("")).toEqual(DEFAULT_AUTO_UPDATE);
        expect(parseAutoUpdatePolicy("not json")).toEqual(DEFAULT_AUTO_UPDATE);
        expect(parseAutoUpdatePolicy('{"mode":"daily","at":"tea time"}')).toEqual(DEFAULT_AUTO_UPDATE);
        expect(DEFAULT_AUTO_UPDATE.mode).toBe("off");
    });
});

describe("when an update installs", () => {
    it("never installs while the policy is off", () => {
        expect(autoUpdateRunsAt({ mode: "off", at: "05:00" }, new Date())).toBeNull();
    });

    it("installs a published build straight away when told to", () => {
        const seen = new Date(2026, 6, 31, 14, 12);
        expect(autoUpdateRunsAt({ mode: "immediate", at: "05:00" }, seen)).toEqual(seen);
    });

    it("takes the same day's window when the build arrived before it", () => {
        const seen = new Date(2026, 6, 31, 2, 0);
        expect(autoUpdateRunsAt(daily("05:00"), seen)).toEqual(new Date(2026, 6, 31, 5, 0));
    });

    it("waits for tomorrow when the build arrived after today's window", () => {
        const seen = new Date(2026, 6, 31, 7, 0);
        expect(autoUpdateRunsAt(daily("05:00"), seen)).toEqual(new Date(2026, 7, 1, 5, 0));
    });

    it("runs at once when the build arrives exactly on the window", () => {
        const seen = new Date(2026, 6, 31, 5, 0);
        expect(autoUpdateRunsAt(daily("05:00"), seen)).toEqual(seen);
    });

    it("rolls over a month boundary rather than producing an invalid date", () => {
        expect(nextDailyRun("05:00", new Date(2026, 6, 31, 23, 30))).toEqual(new Date(2026, 7, 1, 5, 0));
    });

    it("drops sub-minute precision, so a window is a minute and not an instant", () => {
        expect(nextDailyRun("05:00", new Date(2026, 6, 31, 1, 0, 45, 500))).toEqual(new Date(2026, 6, 31, 5, 0, 0, 0));
    });
});

/**
 * Where an update comes from. The two answers mean very different work - a
 * download, or ten minutes of building - so an unreadable setting must land on
 * the cheap one, and nothing outside the pair may be honoured: the same word is
 * handed to a script that runs as root on the host.
 */
describe("update source", () => {
    it("knows only the two ways of updating", () => {
        expect(updateSourceSchema.safeParse("image").success).toBe(true);
        expect(updateSourceSchema.safeParse("build").success).toBe(true);
        expect(updateSourceSchema.safeParse("curl | sh").success).toBe(false);
        expect(updateSourceSchema.safeParse("").success).toBe(false);
    });

    it("falls back to the published image rather than failing", () => {
        expect(parseUpdateSource(null)).toBe("image");
        expect(parseUpdateSource(undefined)).toBe("image");
        expect(parseUpdateSource("nonsense")).toBe("image");
        expect(parseUpdateSource("build")).toBe("build");
    });
});
