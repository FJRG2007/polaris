/**
 * The start, hours and account cases every public link's gate must answer the
 * same way, for a surface test to run against its own gate. `reason` builds the
 * stored row from the overrides, runs the gate, and returns "ok" or the reason
 * it refused; `signIn` sets who the session belongs to, or nobody.
 */

import { expect, it } from "vitest";

export function linkGuardCases(
    reason: (overrides: Record<string, unknown>) => Promise<string>,
    signIn: (viewer: { id: string } | null) => void
): void {
    it("opens as before when it has none of the new rules", async () => {
        signIn(null);
        expect(await reason({})).toBe("ok");
    });

    it("is not open before its start", async () => {
        signIn(null);
        expect(await reason({ startsAt: new Date(Date.now() + 86_400_000) })).toBe("scheduled");
    });

    it("is closed outside its weekly hours", async () => {
        signIn(null);
        // Open only on a day that is not today, in UTC.
        const other = 1 << ((new Date().getUTCDay() + 3) % 7);
        const schedule = { days: other, startMinute: null, endMinute: null, timeZone: "UTC" };
        expect(await reason({ linkSchedule: JSON.stringify(schedule) })).toBe("outside_hours");
    });

    it("asks for an account, then opens only for the people it names", async () => {
        signIn(null);
        expect(await reason({ requireLogin: true })).toBe("sign_in_required");
        signIn({ id: "u-bea" });
        expect(await reason({ requireLogin: true })).toBe("ok");
        expect(await reason({ requireLogin: true, allowedUsers: '["someone-else"]' })).toBe(
            "not_invited"
        );
        expect(await reason({ requireLogin: true, allowedUsers: '["ana"]' })).toBe("ok");
        signIn(null);
    });
}

/** The columns a gate must read with its row for those rules to apply. */
export const LINK_GUARD_SELECT = {
    startsAt: true,
    requireLogin: true,
    allowedUsers: true,
    linkSchedule: true
};
