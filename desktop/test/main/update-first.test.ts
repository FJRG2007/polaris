/**
 * Updating before the app opens: every way out but a working restart opens the
 * app, and a version that did not take never holds a start again.
 */

import type { FirstCheck } from "@/main/updates";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    CHECK_BEFORE_OPENING_MS,
    RESTART_BEFORE_OPENING_MS,
    SETTLE_BEFORE_ASKING_MS,
    UPDATE_BEFORE_OPENING_MS,
    updateBeforeOpening,
    type OpeningSteps
} from "@/main/update-first";

const never = <T>() => new Promise<T>(() => undefined);

function check(overrides: Partial<FirstCheck> = {}): FirstCheck {
    return { asked: Promise.resolve(), installing: Promise.resolve("0.1.3"), installed: Promise.resolve(true), ...overrides };
}

function steps(overrides: Partial<OpeningSteps> = {}) {
    return {
        attempted: vi.fn((): string | null => null),
        attempt: vi.fn(),
        opened: vi.fn(() => false),
        showUpdating: vi.fn(() => never<void>()),
        restart: vi.fn(() => true),
        ...overrides
    };
}

/** Let the start run up to the restart, which a working restart never returns from. */
async function untilRestart(first: FirstCheck, step: OpeningSteps): Promise<void> {
    void updateBeforeOpening(first, step);
    await vi.advanceTimersByTimeAsync(0);
    expect(step.restart).toHaveBeenCalledTimes(1);
}

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe("updating before opening", () => {
    it("restarts into a version found at once, remembering it first", async () => {
        const order: string[] = [];
        const step = steps({
            attempt: vi.fn((version: string) => void order.push(`attempt ${version}`)),
            restart: vi.fn(() => order.push("restart") > 0)
        });
        await untilRestart(check(), step);
        expect(step.showUpdating).toHaveBeenCalledTimes(1);
        expect(order).toEqual(["attempt 0.1.3", "restart"]);
    });

    it("opens the app when nothing is going in", async () => {
        const step = steps();
        expect(await updateBeforeOpening(check({ installing: Promise.resolve(null) }), step)).toBe("open");
        expect(step.showUpdating).not.toHaveBeenCalled();
    });

    it("opens the app when the answer is slow", async () => {
        const step = steps();
        const opening = updateBeforeOpening(check({ installing: never() }), step);
        await vi.advanceTimersByTimeAsync(CHECK_BEFORE_OPENING_MS);
        expect(await opening).toBe("open");
        expect(step.showUpdating).not.toHaveBeenCalled();
    });

    it("gives the answer its full time after a slow signature check", async () => {
        let asked: () => void = () => undefined;
        let answer: (version: string) => void = () => undefined;
        const step = steps();
        void updateBeforeOpening(
            check({ asked: new Promise((resolve) => (asked = resolve)), installing: new Promise((resolve) => (answer = resolve)) }),
            step
        );
        await vi.advanceTimersByTimeAsync(4_000);
        asked();
        await vi.advanceTimersByTimeAsync(CHECK_BEFORE_OPENING_MS - 1);
        answer("0.1.3");
        await vi.advanceTimersByTimeAsync(0);
        expect(step.restart).toHaveBeenCalledTimes(1);
    });

    it("does not wait for ever on a signature check", async () => {
        const opening = updateBeforeOpening(check({ asked: never(), installing: never() }), steps());
        await vi.advanceTimersByTimeAsync(SETTLE_BEFORE_ASKING_MS + CHECK_BEFORE_OPENING_MS);
        expect(await opening).toBe("open");
    });

    it("opens as it is when this version was tried and did not take", async () => {
        const step = steps({ attempted: vi.fn(() => "0.1.3") });
        expect(await updateBeforeOpening(check(), step)).toBe("open");
        expect(step.showUpdating).not.toHaveBeenCalled();
        expect(step.restart).not.toHaveBeenCalled();
    });

    it("tries a newer version than the one that did not take", async () => {
        const step = steps({ attempted: vi.fn(() => "0.1.2") });
        await untilRestart(check(), step);
    });

    it("leaves an app already opened alone", async () => {
        const step = steps({ opened: vi.fn(() => true) });
        expect(await updateBeforeOpening(check(), step)).toBe("open");
        expect(step.showUpdating).not.toHaveBeenCalled();
    });

    it("does not hold the next start for a version whose install failed", async () => {
        const step = steps();
        expect(await updateBeforeOpening(check({ installed: Promise.resolve(false) }), step)).toBe("open");
        expect(step.attempt).toHaveBeenCalledWith("0.1.3");
    });

    it("does not hold the next start for a version that took too long", async () => {
        const step = steps();
        const opening = updateBeforeOpening(check({ installed: never() }), step);
        await vi.advanceTimersByTimeAsync(UPDATE_BEFORE_OPENING_MS);
        expect(await opening).toBe("open");
        expect(step.attempt).toHaveBeenCalledWith("0.1.3");
    });

    it("opens the app when a restart returned and left it running", async () => {
        const step = steps();
        let opened: unknown = null;
        void updateBeforeOpening(check(), step).then((value) => (opened = value));
        await vi.advanceTimersByTimeAsync(RESTART_BEFORE_OPENING_MS - 1);
        expect(step.restart).toHaveBeenCalledTimes(1);
        expect(opened).toBeNull();
        await vi.advanceTimersByTimeAsync(1);
        expect(opened).toBe("open");
    });

    it("opens the app when the install fails", async () => {
        const step = steps();
        expect(await updateBeforeOpening(check({ installed: Promise.resolve(false) }), step)).toBe("open");
        expect(step.restart).not.toHaveBeenCalled();
    });

    it("opens the app when the install takes too long", async () => {
        const step = steps();
        const opening = updateBeforeOpening(check({ installed: never() }), step);
        await vi.advanceTimersByTimeAsync(UPDATE_BEFORE_OPENING_MS);
        expect(await opening).toBe("open");
        expect(step.restart).not.toHaveBeenCalled();
    });

    it("does not restart once the updating window is closed", async () => {
        let finish: (done: boolean) => void = () => undefined;
        const step = steps({ showUpdating: vi.fn(() => Promise.resolve()) });
        const installed = new Promise<boolean>((resolve) => (finish = resolve));
        expect(await updateBeforeOpening(check({ installed }), step)).toBe("closed");
        finish(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(step.restart).not.toHaveBeenCalled();
    });

    it("opens the app when the restart fails", async () => {
        expect(await updateBeforeOpening(check(), steps({ restart: vi.fn(() => false) }))).toBe("open");
    });

    it("does not restart when the attempt cannot be remembered, which could loop", async () => {
        const step = steps({
            attempt: vi.fn(() => {
                throw new Error("disk full");
            })
        });
        expect(await updateBeforeOpening(check(), step)).toBe("open");
        expect(step.restart).not.toHaveBeenCalled();
    });
});
