/**
 * How often the server reads an account while somebody is looking.
 *
 * A unit on the same network every ten seconds, a cloud account at the half
 * minute the screen used to poll at, SwitchBot's ten-thousand-a-day account
 * once a minute; a failing account backs off, doubling to five minutes; and an
 * account something else just read is not read again until it is due.
 */

import { describe, expect, it } from "vitest";
import {
    CLOUD_POLL_MS,
    LOCAL_POLL_MS,
    MAX_BACKOFF_MS,
    backoff,
    dueAccounts,
    pollInterval
} from "@polaris-app/places/src/lib/device-watch";

const NOW = Date.parse("2026-01-01T12:00:00.000Z");

function ago(ms: number): string {
    return new Date(NOW - ms).toISOString();
}

describe("the cadence of one account", () => {
    it("depends on how it is reached", () => {
        expect(pollInterval("shelly-local")).toBe(LOCAL_POLL_MS);
        expect(pollInterval("nuki-local")).toBe(LOCAL_POLL_MS);
        expect(pollInterval("tuya-cloud")).toBe(CLOUD_POLL_MS);
        expect(pollInterval("nuki-web")).toBe(CLOUD_POLL_MS);
        expect(pollInterval("switchbot-cloud")).toBe(60_000);
    });

    it("keeps units that wedge under load at the cloud cadence", () => {
        expect(pollInterval("philips-coap")).toBe(CLOUD_POLL_MS);
    });

    it("backs off on failure, to a ceiling", () => {
        expect(backoff(10_000, 0)).toBe(10_000);
        expect(backoff(10_000, 1)).toBe(20_000);
        expect(backoff(10_000, 3)).toBe(80_000);
        expect(backoff(10_000, 30)).toBe(MAX_BACKOFF_MS);
    });
});

describe("which accounts are due", () => {
    it("reads one never read, and waits for one just read elsewhere", () => {
        const plan = dueAccounts(
            [
                { id: "fresh", connection: "shelly-local", lastSyncedAt: ago(2_000) },
                { id: "never", connection: "tuya-cloud", lastSyncedAt: null }
            ],
            new Map(),
            NOW
        );
        expect(plan.due).toEqual(["never"]);
        // The local one is due again in eight seconds.
        expect(plan.nextInMs).toBe(8_000);
    });

    it("holds a failing account back by its backoff, counted from the failure", () => {
        const failures = new Map([["cloud", { count: 2, at: NOW - 60_000 }]]);
        const plan = dueAccounts(
            [{ id: "cloud", connection: "tuya-cloud", lastSyncedAt: ago(600_000) }],
            failures,
            NOW
        );
        expect(plan.due).toEqual([]);
        expect(plan.nextInMs).toBe(4 * CLOUD_POLL_MS - 60_000);
    });

    it("skips connections Polaris cannot read", () => {
        const plan = dueAccounts(
            [{ id: "tv", connection: "philips-tv", lastSyncedAt: null }],
            new Map(),
            NOW
        );
        expect(plan.due).toEqual([]);
    });
});
