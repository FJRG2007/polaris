/**
 * Deciding when a server's runs are worth writing down.
 *
 * The rule exists to keep two things apart that look identical from one reading:
 * a server that has been up all week and a server that came back thirty seconds
 * ago. It is also what stops the sweep updating every install row every minute to
 * record that nothing happened - so the cases that matter are the moments it does
 * write, and the far more common minute where it must not.
 */

import { describe, expect, it } from "vitest";
import { readServerUptime, uptimePatch, NO_UPTIME } from "@/lib/apps/games-uptime";

const NOW = new Date("2026-08-13T21:00:00.000Z");

function at(minutesAgo: number): string {
    return new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
}

describe("reading what an install recorded", () => {
    it("reads both times back out of the config", () => {
        const uptime = readServerUptime(
            JSON.stringify({ lastOnlineAt: at(1), onlineSince: at(90), hostname: "survival" })
        );
        expect(uptime.lastOnlineAt).toBe(at(1));
        expect(uptime.onlineSince).toBe(at(90));
    });

    it("treats an unreadable config, a missing one and a nonsense date as nothing recorded", () => {
        expect(readServerUptime("not json")).toEqual(NO_UPTIME);
        expect(readServerUptime(null)).toEqual(NO_UPTIME);
        expect(readServerUptime(JSON.stringify({ lastOnlineAt: "whenever", onlineSince: 7 }))).toEqual(NO_UPTIME);
    });
});

describe("what one reading is worth writing", () => {
    it("starts a run the first time a server answers", () => {
        expect(uptimePatch(NO_UPTIME, true, NOW)).toEqual({
            onlineSince: NOW.toISOString(),
            lastOnlineAt: NOW.toISOString()
        });
    });

    it("writes nothing for a server that was up a minute ago and still is", () => {
        expect(uptimePatch({ lastOnlineAt: at(1), onlineSince: at(600) }, true, NOW)).toBeNull();
    });

    it("refreshes the record once it would otherwise go stale, without restarting the run", () => {
        // Also the case of a sweep that merely overran: three minutes is a late
        // sweep, not a server that went away and came back.
        expect(uptimePatch({ lastOnlineAt: at(3), onlineSince: at(600) }, true, NOW)).toEqual({
            lastOnlineAt: NOW.toISOString()
        });
    });

    it("counts a server that answers after a long silence as a new run", () => {
        // The uptime it would otherwise report covers a stretch when it was
        // demonstrably not up.
        expect(uptimePatch({ lastOnlineAt: at(70), onlineSince: at(600) }, true, NOW)).toEqual({
            onlineSince: NOW.toISOString(),
            lastOnlineAt: NOW.toISOString()
        });
    });

    it("closes the run at the moment it is seen going down", () => {
        expect(uptimePatch({ lastOnlineAt: at(1), onlineSince: at(600) }, false, NOW)).toEqual({
            onlineSince: null,
            lastOnlineAt: NOW.toISOString()
        });
    });

    it("writes nothing about a server that was already down", () => {
        expect(uptimePatch({ lastOnlineAt: at(4000), onlineSince: null }, false, NOW)).toBeNull();
        expect(uptimePatch(NO_UPTIME, false, NOW)).toBeNull();
    });
});
