import { manifest } from "./fixtures";
import { describe, expect, it } from "vitest";
import { judgeCall } from "@/shared/plugin-protocol";
import type { AppMessage } from "@/shared/plugin-protocol";
import { readPluginManifest } from "@polaris/core/device-plugins";
import { createSupervisor, MAX_CRASHES, restartDelay, type PluginChild, type WantedPlugin } from "@/main/plugins/supervisor";

class FakeChild implements PluginChild {
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

function harness(granted: WantedPlugin["granted"] = ["usb", "polaris-actions"], locale?: () => string) {
    let clock = 0;
    const timers: { run: () => void; ms: number; }[] = [];
    const children: FakeChild[] = [];
    const calls: string[] = [];
    const live: { id: string; live: unknown }[] = [];
    const levels: { id: string; levels: readonly (number | null)[] }[] = [];
    const supervisor = createSupervisor({
        ...(locale ? { locale } : {}),
        onLive: (id, values) => live.push({ id, live: values }),
        onLevels: (id, values) => levels.push({ id, levels: values }),
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
    const wanted: WantedPlugin = { manifest: readPluginManifest(manifest)!, granted, entryPath: "/x/main.js", settings: { lights: true } };
    return {
        supervisor,
        live,
        levels,
        wanted,
        children,
        timers,
        calls,
        tick: (ms: number) => {
            clock += ms;
        }
    };
}

describe("plugin supervisor", () => {
    it("tells it the app's language when it has one, and nothing when it does not", () => {
        const spanish = harness(undefined, () => "es-ES");
        spanish.supervisor.want(spanish.wanted);
        expect(spanish.children[0]?.sent[0]).toMatchObject({ type: "start", locale: "es-ES" });
        const plain = harness();
        plain.supervisor.want(plain.wanted);
        expect(plain.children[0]?.sent[0]).not.toHaveProperty("locale");
    });

    it("starts it with its permissions and settings, and marks it running once it says so", () => {
        const { supervisor, wanted, children } = harness();
        supervisor.want(wanted);
        expect(children[0]?.sent[0]).toMatchObject({ type: "start", id: "fixture-mixer", permissions: ["usb", "polaris-actions"], settings: { lights: true } });
        expect(supervisor.snapshot()["fixture-mixer"]?.state).toBe("starting");
        children[0]!.say({ type: "ready" });
        expect(supervisor.snapshot()["fixture-mixer"]?.state).toBe("running");
    });

    it("passes on what the device shows now, live, and says at start that it follows it", () => {
        const { supervisor, wanted, children, live } = harness();
        supervisor.want(wanted);
        expect(children[0]?.sent[0]).toMatchObject({ type: "start", live: true });
        children[0]!.say({ type: "ready" });
        const knobs = [{ label: "Calls", volume: 64, muted: false }, { label: "Music", volume: null, muted: true }];
        children[0]!.say({ type: "state", knobs });
        expect(live).toEqual([{ id: "fixture-mixer", live: { knobs } }]);
        // A volume out of range is the wrong shape and goes nowhere.
        children[0]!.say({ type: "state", knobs: [{ label: "Calls", volume: 400, muted: false }] });
        expect(live).toHaveLength(1);
    });

    it("meters a plugin's channels only while a page watches it, and again after a restart", () => {
        const { supervisor, wanted, children, levels, timers } = harness();
        supervisor.want(wanted);
        children[0]!.say({ type: "ready" });
        expect(children[0]!.sent.some((message) => message.type === "watch")).toBe(false);
        supervisor.watch("fixture-mixer", true);
        supervisor.watch("fixture-mixer", true);
        expect(children[0]!.sent.filter((message) => message.type === "watch")).toEqual([{ type: "watch", on: true }]);
        children[0]!.say({ type: "levels", levels: [42, null, 7, 100] });
        expect(levels).toEqual([{ id: "fixture-mixer", levels: [42, null, 7, 100] }]);
        // A restarted process is told at once, after its start.
        children[0]!.crash();
        timers.shift()!.run();
        const sent = children[1]!.sent.map((message) => message.type);
        expect(sent.slice(0, 2)).toEqual(["start", "watch"]);
        supervisor.watch("fixture-mixer", false);
        expect(children[1]!.sent.at(-1)).toEqual({ type: "watch", on: false });
    });

    it("restarts a crashed plugin with a growing delay and gives up after five in a row", () => {
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
