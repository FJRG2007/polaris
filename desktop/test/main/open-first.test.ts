/**
 * A start opens its window before it asks about updates, and never waits for
 * the answer: a release check that never settles still leaves the app open.
 */

import { describe, expect, it, vi } from "vitest";
import { openBeforeChecking } from "@/main/open-first";
import type { FirstCheck } from "@/main/updates";

const never = <T>() => new Promise<T>(() => undefined);

function silentCheck(): FirstCheck {
    return {
        asked: never(),
        installing: never(),
        installed: never(),
        checkNow: () => never(),
        downloaded: () => never()
    };
}

describe("opening before the update check", () => {
    it("opens the window first, then starts the check", () => {
        const order: string[] = [];
        openBeforeChecking({
            open: () => void order.push("open"),
            check: () => {
                order.push("check");
                return silentCheck();
            }
        });
        expect(order).toEqual(["open", "check"]);
    });

    it("has opened by the time it returns, with the check still unanswered", () => {
        const open = vi.fn();
        const first = silentCheck();
        const returned = openBeforeChecking({ open, check: () => first });
        expect(open).toHaveBeenCalledTimes(1);
        expect(returned).toBe(first);
    });

    it("is not a promise: nothing can await the network before the window", () => {
        const returned = openBeforeChecking({ open: () => undefined, check: () => "watch" });
        expect(returned).toBe("watch");
    });

    it("opens even when starting the check throws", () => {
        const open = vi.fn();
        expect(() =>
            openBeforeChecking({
                open,
                check: () => {
                    throw new Error("offline");
                }
            })
        ).toThrow("offline");
        expect(open).toHaveBeenCalledTimes(1);
    });
});
