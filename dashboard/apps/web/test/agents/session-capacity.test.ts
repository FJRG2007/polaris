/**
 * The ceiling on how many sessions exist at once.
 *
 * Nothing bounded this, and the way an unbounded one shows up is not a refusal:
 * it is every deployed app on the box getting slower, then a pull failing on a
 * disk that filled with layers nobody asked for. So the refusal is the feature,
 * and what these pin down is that it fires on the right side of the line and
 * says something a person can act on.
 *
 * Two ceilings, because they answer different questions - one person opening
 * forty, and forty people opening one each - and either alone leaves the other
 * case open.
 */

import { describe, expect, it } from "vitest";
import { capacityRefusal, DEFAULT_PER_ACCOUNT, DEFAULT_TOTAL } from "@/lib/agents/session-capacity";

const room = { mine: 0, perAccount: 3, total: 0, totalCeiling: 12 };

describe("capacityRefusal", () => {
    it("says nothing when there is room", () => {
        expect(capacityRefusal(room)).toBeNull();
        expect(capacityRefusal({ ...room, mine: 2, total: 11 })).toBeNull();
    });

    it("refuses at the ceiling, not past it", () => {
        // The off-by-one that matters: at three of three the next one is the
        // fourth, so it is refused here rather than after it has started.
        expect(capacityRefusal({ ...room, mine: 3 })).not.toBeNull();
        expect(capacityRefusal({ ...room, total: 12 })).not.toBeNull();
    });

    it("blames the account's own ceiling first, since that is the one they can clear", () => {
        // Both crossed. Telling somebody the deployment is full when they are
        // holding three sessions themselves sends them to an administrator over
        // something they can fix in one click.
        const both = capacityRefusal({ mine: 3, perAccount: 3, total: 12, totalCeiling: 12 });
        expect(both).toContain("Stop one");
    });

    it("tells somebody what would free it", () => {
        expect(capacityRefusal({ ...room, mine: 3 })).toContain("Stop one");
        expect(capacityRefusal({ ...room, total: 12 })).toContain("administrator");
    });

    it("says how many the account is holding, not who holds the others", () => {
        const mine = capacityRefusal({ ...room, mine: 3 });
        expect(mine).toContain("3 sessions");
        // The deployment-wide one is a number, not a list of what other people
        // are working on.
        const shared = capacityRefusal({ ...room, total: 12 })!;
        expect(shared).not.toMatch(/\d+ sessions/);
    });

    it("ships defaults that are actually restrictive", () => {
        // A default of zero refuses everything and a default of a thousand bounds
        // nothing. Both are ways of shipping the bug this replaced.
        expect(DEFAULT_PER_ACCOUNT).toBeGreaterThan(0);
        expect(DEFAULT_TOTAL).toBeGreaterThan(DEFAULT_PER_ACCOUNT);
        expect(DEFAULT_TOTAL).toBeLessThan(100);
    });
});
