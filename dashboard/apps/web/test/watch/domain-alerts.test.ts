/**
 * When a domain going down is worth telling somebody about.
 *
 * Two failure modes to keep apart, and both are the kind that erode trust in every
 * other alert: a blip that pages, and an outage that pages every minute it lasts.
 */

import { describe, expect, it } from "vitest";
import { nextAlertState, type DomainHealth } from "@/lib/watch/health-probe";

const DOWN: DomainHealth = { status: "down", code: 502, latencyMs: 12, detail: "HTTP 502" };
const UP: DomainHealth = { status: "up", code: 200, latencyMs: 12, detail: null };
const NOW = new Date("2026-08-04T00:00:00.000Z");

describe("a domain that just started failing", () => {
    it("says nothing on the first failure", () => {
        const next = nextAlertState({ healthFailures: 0, healthAlertedAt: null }, DOWN, NOW);

        expect(next.failures).toBe(1);
        expect(next.alert).toBeNull();
    });

    it("alerts once the failures have piled up", () => {
        const next = nextAlertState({ healthFailures: 2, healthAlertedAt: null }, DOWN, NOW);

        expect(next.alert).toBe("down");
        expect(next.alertedAt).toEqual(NOW);
    });
});

describe("a domain that stays down", () => {
    it("does not alert again on every later probe", () => {
        const next = nextAlertState({ healthFailures: 30, healthAlertedAt: NOW }, DOWN, NOW);

        expect(next.alert).toBeNull();
        expect(next.alertedAt).toEqual(NOW);
    });
});

describe("a domain that comes back", () => {
    it("reports the recovery to whoever heard about the outage", () => {
        const next = nextAlertState({ healthFailures: 5, healthAlertedAt: NOW }, UP, NOW);

        expect(next.alert).toBe("up");
        expect(next.failures).toBe(0);
        // Cleared, so the next outage is a new one and alerts again.
        expect(next.alertedAt).toBeNull();
    });

    it("says nothing when nobody was told it had gone", () => {
        const next = nextAlertState({ healthFailures: 1, healthAlertedAt: null }, UP, NOW);

        expect(next.alert).toBeNull();
        expect(next.failures).toBe(0);
    });
});

describe("a healthy domain", () => {
    it("stays quiet and keeps its streak at zero", () => {
        const next = nextAlertState({ healthFailures: 0, healthAlertedAt: null }, UP, NOW);

        expect(next).toEqual({ failures: 0, alertedAt: null, alert: null });
    });
});
