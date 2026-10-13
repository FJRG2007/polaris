/**
 * One dropped connection is not "Polaris cannot reach this mail server".
 *
 * A Gmail mailbox that synced a minute ago lost one pass to a socket timeout,
 * and the rail said the server could not be reached - which reads as Gmail
 * being down, when the next pass went through. The failure is only put on the
 * screen once a working mailbox has been failing for longer than the grace, or
 * when it never worked at all.
 */

import { describe, expect, it } from "vitest";
import { failureIsNews, UNREACHABLE_GRACE_MS } from "@/lib/mailbox/refusals";

const NOW = Date.parse("2026-10-13T16:31:18Z");
const created = new Date(NOW - 7 * 24 * 60 * 60 * 1000);

function mailbox(state: string, okAgoMs: number | null) {
    return {
        state,
        lastSyncAt: new Date(NOW - 60_000),
        lastOkAt: okAgoMs === null ? null : new Date(NOW - okAgoMs),
        createdAt: created
    };
}

describe("failureIsNews", () => {
    it("keeps a working mailbox quiet over one failed pass", () => {
        expect(failureIsNews(mailbox("ok", 60_000), NOW)).toBe(false);
    });

    it("says so once it has kept failing past the grace", () => {
        expect(failureIsNews(mailbox("ok", UNREACHABLE_GRACE_MS), NOW)).toBe(true);
    });

    it("says so at once for a mailbox that never worked", () => {
        expect(failureIsNews(mailbox("never", null), NOW)).toBe(true);
        expect(failureIsNews(mailbox("ok", null), NOW)).toBe(true);
    });

    it("keeps saying so for a mailbox already shown as unreachable", () => {
        expect(failureIsNews(mailbox("unreachable", 60_000), NOW)).toBe(true);
    });
});
