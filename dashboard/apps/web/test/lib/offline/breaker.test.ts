/**
 * The breaker that stops Polaris waiting on an internet that is not there: it
 * opens on failure, refuses at once while open, lets one probe through when the
 * window passes, and closes on the probe's success.
 */

import { describe, expect, it } from "vitest";
import { Breaker } from "@/lib/offline/breaker";

function clocked(options: ConstructorParameters<typeof Breaker>[0] = {}) {
    let now = 0;
    const changes: boolean[] = [];
    const breaker = new Breaker({
        firstRetryMs: 1000,
        maxRetryMs: 4000,
        probeLeaseMs: 500,
        ...options,
        now: () => now,
        onChange: (open) => changes.push(open)
    });
    return { breaker, changes, advance: (ms: number) => (now += ms) };
}

describe("Breaker", () => {
    it("passes everything while closed", () => {
        const { breaker } = clocked();
        expect(breaker.admit()).toBe("pass");
        expect(breaker.isOpen).toBe(false);
    });

    it("opens on a failure and refuses at once while open", () => {
        const { breaker, changes } = clocked();
        breaker.fail();
        expect(breaker.isOpen).toBe(true);
        expect(breaker.admit()).toBe("refuse");
        expect(breaker.admit()).toBe("refuse");
        expect(changes).toEqual([true]);
    });

    it("needs the threshold's weight to open", () => {
        const { breaker } = clocked({ threshold: 3 });
        breaker.fail();
        breaker.fail();
        expect(breaker.isOpen).toBe(false);
        breaker.succeed();
        breaker.fail();
        breaker.fail();
        expect(breaker.isOpen).toBe(false);
        breaker.fail(Number.POSITIVE_INFINITY);
        expect(breaker.isOpen).toBe(true);
    });

    it("lets exactly one probe through once the window passes", () => {
        const { breaker, advance } = clocked();
        breaker.fail();
        advance(999);
        expect(breaker.admit()).toBe("refuse");
        advance(1);
        expect(breaker.admit()).toBe("probe");
        expect(breaker.admit()).toBe("refuse");
    });

    it("closes when the probe succeeds, and says so once", () => {
        const { breaker, changes, advance } = clocked();
        breaker.fail();
        advance(1000);
        expect(breaker.admit()).toBe("probe");
        breaker.succeed();
        expect(breaker.isOpen).toBe(false);
        expect(breaker.admit()).toBe("pass");
        expect(changes).toEqual([true, false]);
    });

    it("doubles the window after a failed probe, up to the ceiling", () => {
        const { breaker, advance } = clocked();
        breaker.fail();
        const windows: number[] = [];
        for (let round = 0; round < 4; round++) {
            let waited = 0;
            while (breaker.admit() !== "probe") {
                advance(100);
                waited += 100;
            }
            windows.push(waited);
            breaker.fail();
        }
        expect(windows).toEqual([1000, 2000, 4000, 4000]);
    });

    it("ignores a failure that was already in flight when it opened", () => {
        const { breaker, advance } = clocked();
        breaker.fail();
        breaker.fail();
        advance(1000);
        expect(breaker.admit()).toBe("probe");
    });

    it("gives the probe slot to another caller when a probe never reports", () => {
        const { breaker, advance } = clocked();
        breaker.fail();
        advance(1000);
        expect(breaker.admit()).toBe("probe");
        advance(499);
        expect(breaker.admit()).toBe("refuse");
        advance(1);
        expect(breaker.admit()).toBe("probe");
    });

    it("starts over from the first window after recovering", () => {
        const { breaker, advance } = clocked();
        breaker.fail();
        advance(1000);
        breaker.admit();
        breaker.fail();
        advance(2000);
        breaker.admit();
        breaker.succeed();
        breaker.fail();
        advance(1000);
        expect(breaker.admit()).toBe("probe");
    });
});
