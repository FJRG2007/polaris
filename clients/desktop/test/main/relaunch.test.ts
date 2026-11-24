/**
 * The calls held in the main process: what a restart writes down is what the
 * pages are on at that moment, and a page that left its call is not carried.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const stored = vi.hoisted(() => ({ mark: null as unknown }));
vi.mock("@/main/settings", () => ({
    rememberRelaunch: (mark: unknown) => void (stored.mark = mark),
    takeRelaunch: () => {
        const mark = stored.mark;
        stored.mark = null;
        return mark;
    }
}));

const HERE = "https://polaris.example.test";

beforeEach(() => {
    vi.resetModules();
    stored.mark = null;
});

describe("calls carried across a restart", () => {
    it("writes down the calls on now, and hands them back on the next start", async () => {
        const before = await import("@/main/relaunch");
        before.holdCall(1, HERE, "on a call");
        before.holdCall(2, HERE, "left it");
        before.holdCall(2, HERE, null);
        before.markRelaunch("update", 1_000);
        expect(stored.mark).toEqual({ reason: "update", at: 1_000, calls: [{ origin: HERE, note: "on a call" }] });

        vi.resetModules();
        const after = await import("@/main/relaunch");
        after.loadRelaunch();
        expect(after.relaunched(HERE, 2_000)).toEqual({ reason: "update", at: 1_000, call: "on a call" });
        expect(after.relaunched(HERE, 2_500)).toEqual({ reason: "update", at: 1_000, call: null });
    });

    it("tells a run nobody restarted nothing", async () => {
        const run = await import("@/main/relaunch");
        run.loadRelaunch();
        expect(run.relaunched(HERE, 2_000)).toBeNull();
    });
});
