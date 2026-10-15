/**
 * How an incident moves between states.
 */

import { describe, expect, it } from "vitest";
import {
    canTransition,
    maintenanceActive,
    transition
} from "@polaris-app/status-pages/src/model/incidents";

const at = new Date("2026-03-10T12:00:00Z");
const earlier = new Date("2026-03-10T10:00:00Z");

describe("transition", () => {
    it("moves freely between open states", () => {
        expect(transition({ state: "investigating", resolvedAt: null }, "identified", at)).toEqual({
            ok: true,
            state: "identified",
            resolvedAt: null
        });
        expect(transition({ state: "monitoring", resolvedAt: null }, "investigating", at).ok).toBe(
            true
        );
    });

    it("stamps the moment an incident is resolved", () => {
        expect(transition({ state: "monitoring", resolvedAt: null }, "resolved", at)).toEqual({
            ok: true,
            state: "resolved",
            resolvedAt: at
        });
    });

    it("keeps the first resolution time on a further resolved update", () => {
        expect(transition({ state: "resolved", resolvedAt: earlier }, "resolved", at)).toEqual({
            ok: true,
            state: "resolved",
            resolvedAt: earlier
        });
    });

    it("reopens a resolved incident only as investigating", () => {
        expect(transition({ state: "resolved", resolvedAt: earlier }, "investigating", at)).toEqual(
            {
                ok: true,
                state: "investigating",
                resolvedAt: null
            }
        );
        expect(transition({ state: "resolved", resolvedAt: earlier }, "monitoring", at)).toEqual({
            ok: false,
            reason: "resolvedReopen"
        });
        expect(canTransition("resolved", "identified")).toBe(false);
    });
});

describe("maintenanceActive", () => {
    it("covers its start and not its end", () => {
        const window = { startsAt: earlier, endsAt: at };
        expect(maintenanceActive(window, earlier)).toBe(true);
        expect(maintenanceActive(window, new Date("2026-03-10T11:00:00Z"))).toBe(true);
        expect(maintenanceActive(window, at)).toBe(false);
        expect(maintenanceActive(window, new Date("2026-03-10T09:00:00Z"))).toBe(false);
    });
});
