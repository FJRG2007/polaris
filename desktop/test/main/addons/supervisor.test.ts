import { manifest } from "./fixtures";
import { describe, expect, it } from "vitest";
import { judgeCall } from "@/shared/addon-protocol";
import type { AppMessage } from "@/shared/addon-protocol";
import { readAddonManifest } from "@polaris/core/device-addons";
import { createSupervisor, MAX_CRASHES, restartDelay, type AddonChild, type WantedAddon } from "@/main/addons/supervisor";

class FakeChild implements AddonChild {
    sent: AppMessage[] = [];
    killed = false;
    private message: ((message: unknown) => void) | null = null;
    private exit: ((code: number) => void) | null = null;
    postMessage(message: AppMessage): void {
        this.sent.push(message);
    }
    kill(): void {
        this.killed = true;
    }
    onMessage(listener: (message: unknown) => void): void {
        this.message = listener;
    }
    onExit(listener: (code: number) => void): void {
        this.exit = listener;
    }
    say(message: unknown): void {
        this.message?.(message);
    }
    crash(): void {
        this.exit?.(1);
    }
}

function harness(granted: WantedAddon["granted"] = ["usb", "polaris-actions"]) {
    let clock = 0;
    const timers: { run: () => void; ms: number; }[] = [];
    const children: FakeChild[] = [];
    const calls: string[] = [];
    const supervisor = createSupervisor({
        fork: () => {
            const child = new FakeChild();
            children.push(child);
            return child;
        },
        call: async (_id, method) => {
            calls.push(method);
            return "done";
        },
        now: () => clock,
        setTimer: (run, ms) => timers.push({ run, ms }),
        clearTimer: () => undefined
    });
    const wanted: WantedAddon = { manifest: readAddonManifest(manifest)!, granted, entryPath: "/x/main.js", settings: { lights: true } };
    return {
        supervisor,
        wanted,
        children,
        timers,
        calls,
        tick: (ms: number) => {
            clock += ms;
        }
    };
}

describe("add-on supervisor", () => {
    it("starts it with its permissions and settings, and marks it running once it says so", () => {
        const { supervisor, wanted, children } = harness();
        supervisor.want(wanted);
        expect(children[0]?.sent[0]).toMatchObject({ type: "start", id: "fixture-mixer", permissions: ["usb", "polaris-actions"], settings: { lights: true } });
        expect(supervisor.snapshot()["fixture-mixer"]?.state).toBe("starting");
        children[0]!.say({ type: "ready" });
        expect(supervisor.snapshot()["fixture-mixer"]?.state).toBe("running");
    });

    it("restarts a crashed add-on with a growing delay and gives up after five in a row", () => {
        const { supervisor, wanted, children, timers } = harness();
        supervisor.want(wanted);
        for (let i = 0; i < MAX_CRASHES - 1; i++) {
            children.at(-1)!.crash();
            expect(supervisor.snapshot()["fixture-mixer"]?.state).toBe("restarting");
            timers.shift()!.run();
        }
        expect(children).toHaveLength(MAX_CRASHES);
        children.at(-1)!.crash();
        expect(supervisor.snapshot()["fixture-mixer"]?.state).toBe("failed");
        expect(timers).toHaveLength(0);
        expect([1, 2, 3, 4, 10].map(restartDelay)).toEqual([1_000, 2_000, 4_000, 8_000, 60_000]);
    });

    it("forgets earlier crashes after a healthy minute", () => {
        const { supervisor, wanted, children, timers, tick } = harness();
        supervisor.want(wanted);
        children[0]!.crash();
        timers.shift()!.run();
        tick(61_000);
        children[1]!.crash();
        expect(supervisor.snapshot()["fixture-mixer"]?.crashes).toBe(1);
    });

    it("does not restart one that was dropped, and ignores a dropped process's exit", () => {
        const { supervisor, wanted, children, timers } = harness();
        supervisor.want(wanted);
        supervisor.drop("fixture-mixer");
        expect(children[0]?.killed).toBe(true);
        children[0]!.crash();
        expect(timers).toHaveLength(0);
        expect(supervisor.snapshot()).toEqual({});
    });

    it("answers a call only with the permission it needs", async () => {
        const { supervisor, wanted, children, calls } = harness(["usb"]);
        supervisor.want(wanted);
        const child = children[0]!;
        child.say({ type: "call", id: 1, method: "polaris.action", params: { action: "call.mic" } });
        child.say({ type: "call", id: 2, method: "settings.get" });
        child.say({ type: "call", id: 3, method: "fs.read", params: { path: "/etc/passwd" } });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(calls).toEqual(["settings.get"]);
        expect(child.sent.filter((message) => message.type === "reply")).toEqual([
            { type: "reply", id: 1, ok: false, error: "permission" },
            { type: "reply", id: 3, ok: false, error: "unknown-method" },
            { type: "reply", id: 2, ok: true, value: "done" }
        ]);
    });

    it("checks parameters and ignores messages of the wrong shape", () => {
        expect(judgeCall(["polaris-actions"], "polaris.action", { action: "shell.run" })).toEqual({ ok: false, error: "bad-params" });
        expect(judgeCall(["polaris-actions"], "polaris.action", { action: "call.deafen" })).toMatchObject({ ok: true });
        expect(judgeCall([], "constructor", undefined)).toEqual({ ok: false, error: "unknown-method" });
        const { supervisor, wanted, children } = harness();
        supervisor.want(wanted);
        children[0]!.say({ type: "ready", extra: () => 1 });
        children[0]!.say("garbage");
        expect(supervisor.snapshot()["fixture-mixer"]?.state).toBe("running");
    });

    it("passes devices and settings to the running process", () => {
        const { supervisor, wanted, children } = harness();
        supervisor.want(wanted);
        supervisor.devices([{ vendorId: 1, productId: 2 }]);
        supervisor.settings("fixture-mixer", { lights: false });
        expect(children[0]?.sent.slice(1)).toEqual([
            { type: "devices", devices: [{ vendorId: 1, productId: 2 }] },
            { type: "settings", settings: { lights: false } }
        ]);
    });
});
