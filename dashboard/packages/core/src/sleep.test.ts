/**
 * When a service sleeps and when it wakes - and that not knowing never puts one to
 * sleep.
 */

import { describe, expect, it } from "vitest";
import { countsAsVisit, HEALTH_PROBE_USER_AGENT, sleepDecision, type SleepFacts } from "./sleep.js";

const NOW = Date.parse("2026-09-10T12:00:00Z");
const MIN = 60_000;
const awake: SleepFacts = {
    sleepAfterMinutes: 15,
    asleepSince: null,
    lastVisit: NOW - 20 * MIN,
    windowStart: NOW - 60 * MIN,
    awakeSince: NOW - 120 * MIN,
    now: NOW
};

describe("sleepDecision", () => {
    it("sleeps a service idle for longer than its setting", () => {
        expect(sleepDecision(awake)).toBe("sleep");
    });

    it("keeps one visited within the stretch", () => {
        expect(sleepDecision({ ...awake, lastVisit: NOW - 5 * MIN })).toBe("stay");
    });

    it("keeps one that only just started, whatever the log says", () => {
        expect(sleepDecision({ ...awake, awakeSince: NOW - 2 * MIN })).toBe("stay");
    });

    it("never sleeps on a log too short to show the whole stretch", () => {
        expect(sleepDecision({ ...awake, lastVisit: null, windowStart: NOW - 5 * MIN })).toBe(
            "stay"
        );
        expect(sleepDecision({ ...awake, lastVisit: null, windowStart: null })).toBe("stay");
        expect(sleepDecision({ ...awake, lastVisit: null, windowStart: NOW - 30 * MIN })).toBe(
            "sleep"
        );
    });

    it("leaves a service with sleeping off alone", () => {
        expect(sleepDecision({ ...awake, sleepAfterMinutes: null })).toBe("stay");
    });

    it("wakes on a visit after it went to sleep, and not on one before", () => {
        const asleep = { ...awake, asleepSince: NOW - 10 * MIN };
        expect(sleepDecision({ ...asleep, lastVisit: NOW - 1000 })).toBe("wake");
        expect(sleepDecision({ ...asleep, lastVisit: NOW - 20 * MIN })).toBe("stay");
    });

    it("wakes a sleeping service when sleeping is turned off", () => {
        expect(
            sleepDecision({
                ...awake,
                asleepSince: NOW - MIN,
                sleepAfterMinutes: null,
                lastVisit: null
            })
        ).toBe("wake");
    });
});

describe("countsAsVisit", () => {
    it("counts people, not Polaris's own probe or refused requests", () => {
        expect(countsAsVisit({ status: 200, userAgent: "Mozilla/5.0" })).toBe(true);
        expect(countsAsVisit({ status: 502, userAgent: "Mozilla/5.0" })).toBe(true);
        expect(countsAsVisit({ status: 200, userAgent: HEALTH_PROBE_USER_AGENT })).toBe(false);
        expect(countsAsVisit({ status: 403, userAgent: "curl/8" })).toBe(false);
        expect(countsAsVisit({ status: 429, userAgent: "curl/8" })).toBe(false);
    });
});
