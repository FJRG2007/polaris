/**
 * The update the page's header offers: only one that is installed and waits
 * for a restart, told to the pages when it changes, and restarted into once
 * however often the button is pressed.
 */

import { describe, expect, it, vi } from "vitest";
import { UpdateReadyState } from "@/main/update-ready";
import { readUpdateReady, updateReadySchema } from "@/shared/update-ready";

describe("UpdateReadyState", () => {
    it("holds nothing until an installed update is found", () => {
        const changed = vi.fn();
        const state = new UpdateReadyState(changed);
        expect(state.current()).toBeNull();
        expect(state.install()).toEqual({ ok: false, error: expect.any(String) });
        expect(changed).not.toHaveBeenCalled();
    });

    it("ignores an update that can only be downloaded from its page", () => {
        const changed = vi.fn();
        const state = new UpdateReadyState(changed);
        state.found({ version: "0.1.3" });
        expect(state.current()).toBeNull();
        expect(changed).not.toHaveBeenCalled();
    });

    it("tells the pages once when an update is ready, and restarts into it once", () => {
        const changed = vi.fn();
        const restart = vi.fn();
        const state = new UpdateReadyState(changed);
        state.found({ version: "0.1.3", restart });
        state.found({ version: "0.1.3", restart });
        expect(changed).toHaveBeenCalledTimes(1);
        expect(changed).toHaveBeenCalledWith({ version: "0.1.3" });
        expect(state.current()).toEqual({ version: "0.1.3" });

        expect(state.install()).toEqual({ ok: true });
        expect(state.install()).toEqual({ ok: true });
        expect(restart).toHaveBeenCalledTimes(1);
    });

    it("keeps an installed update when a newer one could only be offered as a page", () => {
        const state = new UpdateReadyState(vi.fn());
        state.found({ version: "0.1.3", restart: vi.fn() });
        state.found({ version: "0.1.4" });
        expect(state.current()).toEqual({ version: "0.1.3" });
    });

    it("moves to a newer installed update and lets it be installed", () => {
        const changed = vi.fn();
        const older = vi.fn();
        const newer = vi.fn();
        const state = new UpdateReadyState(changed);
        state.found({ version: "0.1.3", restart: older });
        state.found({ version: "0.1.4", restart: newer });
        expect(changed).toHaveBeenLastCalledWith({ version: "0.1.4" });
        state.install();
        expect(older).not.toHaveBeenCalled();
        expect(newer).toHaveBeenCalledTimes(1);
    });

    it("answers a failed restart as a sentence and lets it be tried again", () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const restart = vi.fn(() => {
            throw new Error("Squirrel said no");
        });
        const state = new UpdateReadyState(vi.fn());
        state.found({ version: "0.1.3", restart });
        const outcome = state.install();
        expect(outcome.ok).toBe(false);
        expect(JSON.stringify(outcome)).not.toContain("Squirrel");
        state.install();
        expect(restart).toHaveBeenCalledTimes(2);
        error.mockRestore();
    });

    it("never holds a version that is not one", () => {
        const changed = vi.fn();
        const state = new UpdateReadyState(changed);
        state.found({ version: "<img src=x>", restart: vi.fn() });
        expect(state.current()).toBeNull();
        expect(changed).not.toHaveBeenCalled();
    });
});

describe("which pages draw the button", () => {
    it("counts no page until one says it draws the button - an older dashboard never does", () => {
        const state = new UpdateReadyState(vi.fn());
        expect(state.offeredBy(7)).toBe(false);
        expect(state.offeredBy(null)).toBe(false);
    });

    it("follows each window's page on its own", () => {
        const state = new UpdateReadyState(vi.fn());
        state.offer(1, true);
        state.offer(2, true);
        expect(state.offeredBy(1)).toBe(true);
        expect(state.offeredBy(2)).toBe(true);
        state.offer(1, false);
        expect(state.offeredBy(1)).toBe(false);
        expect(state.offeredBy(2)).toBe(true);
        expect(state.offeredBy(3)).toBe(false);
    });

    it("announces an installed update itself unless the page in front draws the button", () => {
        const state = new UpdateReadyState(vi.fn());
        const installed = { version: "0.1.3", restart: vi.fn() };
        // An older dashboard, the address form, no window at all.
        expect(state.needsNotice(installed, 1)).toBe(true);
        expect(state.needsNotice(installed, null)).toBe(true);
        state.offer(1, true);
        expect(state.needsNotice(installed, 1)).toBe(false);
        // Another window in front, on a page without the button.
        expect(state.needsNotice(installed, 2)).toBe(true);
        // A download page is never the button's.
        expect(state.needsNotice({ version: "0.1.4" }, 1)).toBe(true);
    });
});

describe("the update state on the bridge", () => {
    it("reads a ready update and nothing else", () => {
        expect(readUpdateReady({ version: "0.1.3" })).toEqual({ version: "0.1.3" });
        expect(readUpdateReady({ version: "1.0.0-beta.2" })).toEqual({ version: "1.0.0-beta.2" });
        expect(readUpdateReady(null)).toBeNull();
        expect(readUpdateReady(undefined)).toBeNull();
        expect(readUpdateReady({ version: 3 })).toBeNull();
        expect(readUpdateReady({ version: "0.1.3", restart: "now" })).toBeNull();
        expect(readUpdateReady("0.1.3")).toBeNull();
        expect(updateReadySchema.safeParse({ version: "x".repeat(65) }).success).toBe(false);
    });
});
