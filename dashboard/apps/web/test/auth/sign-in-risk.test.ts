/**
 * The risk check a password-only sign-in may owe: impossible travel read by
 * continent and time, and the one-code plan that is never a dead end.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));

const { impossibleTravel, TRAVEL_WINDOW_MS } = await import("@/lib/sign-in-risk");
const { planRiskCheck, parseStepUp, serializeStepUp } = await import("@/lib/two-factor-policy");

const NOW = new Date("2026-11-23T12:00:00Z");

describe("impossibleTravel", () => {
    it("flags another continent within the window", () => {
        expect(impossibleTravel({ country: "ES", at: new Date(NOW.getTime() - 60_000) }, "US", NOW)).toBe(true);
    });

    it("lets a neighbouring country, a long gap, or an unknown place through", () => {
        expect(impossibleTravel({ country: "ES", at: new Date(NOW.getTime() - 60_000) }, "FR", NOW)).toBe(false);
        expect(impossibleTravel({ country: "ES", at: new Date(NOW.getTime() - TRAVEL_WINDOW_MS - 1) }, "US", NOW)).toBe(false);
        expect(impossibleTravel(null, "US", NOW)).toBe(false);
        expect(impossibleTravel({ country: "ES", at: NOW }, null, NOW)).toBe(false);
    });
});

describe("planRiskCheck", () => {
    it("asks for one code from any reachable method", () => {
        const plan = planRiskCheck({ available: ["email", "whatsapp"], reason: "new-device" });
        expect(plan).toMatchObject({ need: 1, done: [], accepted: ["email", "whatsapp"], reason: "new-device" });
        expect(parseStepUp(serializeStepUp(plan!))).toEqual(plan);
    });

    it("asks nothing when no code can be delivered", () => {
        expect(planRiskCheck({ available: [], reason: "impossible-travel" })).toBeNull();
    });
});
