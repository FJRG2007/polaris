/**
 * Applying the ad blocker's configuration again after a daylight-saving change:
 * only when the clock is the whole difference, and never with no server to take it.
 */

import { describe, expect, it } from "vitest";
import * as dns from "@/lib/dns-blocker/settings";
import { encodeBlockyConfig } from "@/lib/dns-blocker/render";
import { clockChangeDecision } from "@/lib/dns-blocker/clock-change";

// Madrid leaves summer time at 01:00 UTC on 2026-10-25 (UTC+2 -> UTC+1).
const BEFORE_FALL = new Date("2026-10-24T12:00:00Z");
const AFTER_FALL = new Date("2026-10-25T03:00:00Z");
// New York enters summer time at 07:00 UTC on 2026-03-08 (UTC-5 -> UTC-4).
const BEFORE_SPRING = new Date("2026-03-08T06:00:00Z");
const AFTER_SPRING = new Date("2026-03-08T08:00:00Z");

const RUNNING = { running: true };

function settings(patch: Partial<dns.DnsSettings> = {}): dns.DnsSettings {
    return {
        ...dns.DEFAULT_DNS_SETTINGS,
        sources: ["hagezi-pro", "hagezi-social"],
        schedules: [{ lists: ["social"], days: ["mon", "sat"], start: "21:00", end: "07:00" }],
        timeZone: "Europe/Madrid",
        ...patch
    };
}

describe("clockChangeDecision", () => {
    it("applies again when the clock moved the schedules and nothing else changed", () => {
        const stored = encodeBlockyConfig(settings(), BEFORE_FALL);
        expect(encodeBlockyConfig(settings(), AFTER_FALL)).not.toBe(stored);
        expect(
            clockChangeDecision({ engine: RUNNING, stored, settings: settings(), now: AFTER_FALL })
        ).toEqual({ apply: true, encoded: encodeBlockyConfig(settings(), AFTER_FALL) });
    });

    it("applies again when the clock moves forward too", () => {
        const zoned = settings({ timeZone: "America/New_York" });
        const stored = encodeBlockyConfig(zoned, BEFORE_SPRING);
        expect(
            clockChangeDecision({ engine: RUNNING, stored, settings: zoned, now: AFTER_SPRING })
        ).toEqual({ apply: true, encoded: encodeBlockyConfig(zoned, AFTER_SPRING) });
    });

    it("does nothing when the server already runs what the settings render to", () => {
        const stored = encodeBlockyConfig(settings(), AFTER_FALL);
        expect(
            clockChangeDecision({ engine: RUNNING, stored, settings: settings(), now: AFTER_FALL })
        ).toEqual({ apply: false, reason: "current" });
    });

    it("does nothing with no server, or one that is not up", () => {
        const stored = encodeBlockyConfig(settings(), BEFORE_FALL);
        const input = { stored, settings: settings(), now: AFTER_FALL };
        expect(clockChangeDecision({ ...input, engine: null })).toEqual({
            apply: false,
            reason: "noEngine"
        });
        expect(clockChangeDecision({ ...input, engine: { running: false } })).toEqual({
            apply: false,
            reason: "engineDown"
        });
    });

    it("leaves every difference that is not the clock to the screen", () => {
        // Saved while the server could not take it: more than the hours differ.
        const older = encodeBlockyConfig(settings({ deny: ["example.test"] }), BEFORE_FALL);
        expect(
            clockChangeDecision({
                engine: RUNNING,
                stored: older,
                settings: settings(),
                now: AFTER_FALL
            })
        ).toEqual({ apply: false, reason: "notClock" });
        // The same settings, the same offset, still different: not the clock either.
        const unscheduled = settings({ schedules: [] });
        expect(
            clockChangeDecision({
                engine: RUNNING,
                stored: encodeBlockyConfig(
                    settings({ schedules: [], deny: ["example.test"] }),
                    AFTER_FALL
                ),
                settings: unscheduled,
                now: AFTER_FALL
            })
        ).toEqual({ apply: false, reason: "notClock" });
        expect(
            clockChangeDecision({
                engine: RUNNING,
                stored: null,
                settings: settings(),
                now: AFTER_FALL
            })
        ).toEqual({ apply: false, reason: "notClock" });
    });

    it("never treats a zone without daylight saving as moved", () => {
        const fixed = settings({ timeZone: "Asia/Kolkata" });
        const stored = encodeBlockyConfig(
            settings({ timeZone: "Asia/Kolkata", deny: ["a.test"] }),
            BEFORE_FALL
        );
        expect(
            clockChangeDecision({ engine: RUNNING, stored, settings: fixed, now: AFTER_FALL })
        ).toEqual({ apply: false, reason: "notClock" });
    });
});
