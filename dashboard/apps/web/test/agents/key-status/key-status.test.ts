/**
 * A key's standing as the keys table says it: a running cool-down wins and
 * names its end, its refusal decides which words, and otherwise the router's
 * own allowance verdict stands.
 */

import { describe, expect, it } from "vitest";
import { isCoolingState, keyStatus, revivedStatus } from "@/lib/agents/key-status";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const LATER = "2026-11-10T12:05:00.000Z";
const EARLIER = "2026-11-10T11:55:00.000Z";
const SPEND = { requestsToday: 3, tokensToday: 400, tokensThisMonth: 9000 };

describe("keyStatus", () => {
    it("is ready with no cool-down and no limit reached", () => {
        const status = keyStatus({ coolingUntil: null, coolingReason: null }, SPEND, "ready", NOW);
        expect(status).toEqual({ state: "ready", until: null, reason: null, ...SPEND });
    });

    it("says a rate refusal is a cool-down until when", () => {
        const status = keyStatus({ coolingUntil: LATER, coolingReason: "rate" }, SPEND, "ready", NOW);
        expect(status).toMatchObject({ state: "cooling", until: LATER, reason: "rate" });
    });

    it("tells a refused key and an empty account apart", () => {
        const at = (reason: string) =>
            keyStatus({ coolingUntil: LATER, coolingReason: reason }, undefined, "ready", NOW).state;
        expect(at("key")).toBe("refused");
        expect(at("credit")).toBe("no_credit");
        expect(at("paid")).toBe("no_credit");
        expect(at("busy")).toBe("cooling");
    });

    it("lets a running cool-down win over a reached limit", () => {
        const status = keyStatus(
            { coolingUntil: LATER, coolingReason: "rate" },
            SPEND,
            "limit_day",
            NOW
        );
        expect(status.state).toBe("cooling");
    });

    it("ignores a cool-down that has ended, and keeps the allowance verdict", () => {
        const status = keyStatus(
            { coolingUntil: EARLIER, coolingReason: "rate" },
            SPEND,
            "limit_month",
            NOW
        );
        expect(status).toMatchObject({ state: "limit_month", until: null, reason: null });
    });

    it("counts a key with no recorded calls as nothing spent", () => {
        const status = keyStatus({ coolingUntil: null, coolingReason: null }, undefined, "ready", NOW);
        expect(status.requestsToday).toBe(0);
        expect(status.tokensThisMonth).toBe(0);
    });
});

describe("revive", () => {
    it("offers the action only on a cooled key, and reads ready after it", () => {
        expect(isCoolingState("cooling")).toBe(true);
        expect(isCoolingState("refused")).toBe(true);
        expect(isCoolingState("no_credit")).toBe(true);
        expect(isCoolingState("limit_day")).toBe(false);
        expect(isCoolingState("ready")).toBe(false);
        const cooled = keyStatus({ coolingUntil: LATER, coolingReason: "rate" }, SPEND, "ready", NOW);
        expect(revivedStatus(cooled)).toMatchObject({ state: "ready", until: null, reason: null });
    });
});
