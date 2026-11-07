/**
 * Waiting on the TV: the port is polled while debugging is off, a prompt nobody
 * answered comes back on its own, and the wait ends on a connection, a cancel,
 * the deadline, or a failure waiting cannot fix - never on a "retry" press.
 */

import { describe, expect, it } from "vitest";
import { stepAfter, waitForTv, type TvWaitOptions, type TvWaitStep } from "@/main/tv-wait";

type Port = "open" | "refused" | "silent";
/** One scripted poll: what the port says, and what a connection attempt then does. */
type Tick = Port | { port: "open"; connect: "ok" | string; };

function script(ticks: readonly Tick[], extra: Partial<TvWaitOptions<string>> = {}) {
    let clock = 0;
    let at = -1;
    const steps: TvWaitStep[] = [];
    let attempts = 0;
    const current = () => ticks[Math.min(at, ticks.length - 1)]!;
    const options: TvWaitOptions<string> = {
        probe: async () => {
            at += 1;
            const tick = current();
            return typeof tick === "string" ? tick : tick.port;
        },
        connect: async () => {
            attempts += 1;
            const tick = current();
            const result = typeof tick === "string" ? "ok" : tick.connect;
            if (result === "ok") return "connection";
            throw new Error(result);
        },
        classify: (error) => (error as Error).message,
        onStep: (step) => steps.push(step),
        cancelled: () => false,
        sleep: async (ms) => {
            clock += ms;
        },
        now: () => clock,
        intervalMs: 2_000,
        timeoutMs: 60_000,
        ...extra
    };
    return { run: () => waitForTv(options), steps, attempts: () => attempts, clock: () => clock };
}

describe("waitForTv", () => {
    it("connects at once when debugging is already on, with no instruction", async () => {
        const wait = script(["open"]);
        expect(await wait.run()).toEqual({ kind: "connected", connection: "connection" });
        expect(wait.steps).toEqual([]);
    });

    it("shows the debugging instruction once and polls until the port opens", async () => {
        const wait = script(["refused", "refused", "silent", "open"]);
        expect((await wait.run()).kind).toBe("connected");
        expect(wait.steps).toEqual(["debugging"]);
        expect(wait.clock()).toBe(6_000);
    });

    it("asks again for the prompt nobody answered, then connects", async () => {
        const wait = script([
            { port: "open", connect: "not-allowed" },
            { port: "open", connect: "not-allowed" },
            { port: "open", connect: "ok" }
        ]);
        expect((await wait.run()).kind).toBe("connected");
        expect(wait.steps).toEqual(["prompt"]);
        expect(wait.attempts()).toBe(3);
    });

    it("keeps the prompt step while the port blinks, and goes back to debugging when it refuses", async () => {
        const wait = script([{ port: "open", connect: "not-allowed" }, "silent", { port: "open", connect: "adb-off" }, "open"]);
        expect((await wait.run()).kind).toBe("connected");
        expect(wait.steps).toEqual(["prompt", "debugging"]);
    });

    it("stops on a failure waiting cannot fix", async () => {
        const wait = script([{ port: "open", connect: "usb-busy" }]);
        expect(await wait.run()).toEqual({ kind: "failed", outcome: "usb-busy" });
    });

    it("ends at the deadline, saying which step it was on", async () => {
        const wait = script(["refused"], { timeoutMs: 10_000 });
        expect(await wait.run()).toEqual({ kind: "timeout", step: "debugging" });
        const prompt = script([{ port: "open", connect: "not-allowed" }], { timeoutMs: 10_000 });
        expect(await prompt.run()).toEqual({ kind: "timeout", step: "prompt" });
    });

    it("stops when cancelled, without another attempt", async () => {
        let polls = 0;
        const wait = script(["refused"], {
            cancelled: () => polls >= 2,
            probe: async () => {
                polls += 1;
                return "refused";
            }
        });
        expect(await wait.run()).toEqual({ kind: "cancelled" });
        expect(polls).toBe(2);
    });

    it("reads each failure as the step it leaves the person at", () => {
        expect(stepAfter("not-allowed")).toBe("prompt");
        expect(stepAfter("adb-off")).toBe("debugging");
        expect(stepAfter("unreachable")).toBe("debugging");
        expect(stepAfter("usb-gone")).toBeNull();
    });
});
