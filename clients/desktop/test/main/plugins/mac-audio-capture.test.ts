import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { AUDIO_CAPTURE_REQUIREMENT, audioCaptureRunnerFor, requirementRunnerFor } from "../../../src/main/plugins/official";
import { ANSWER_WAIT_MS, createAudioCaptureRunner, decideAudioCapture, installedModuleLoader, type AudioAccessModule } from "../../../src/main/plugins/mac-audio-capture";

/** A module whose answer moves through `answers`, one per read, staying on the last. */
function fakeModule(answers: string[]) {
    let at = 0;
    const module: AudioAccessModule & { requested: number; } = {
        requested: 0,
        audioAccess: () => answers[Math.min(at++, answers.length - 1)] ?? "notAsked",
        requestAudioAccess: () => {
            module.requested += 1;
        }
    };
    return module;
}

function fakeDeps(module: AudioAccessModule | null) {
    let clock = 0;
    return {
        load: async () => module,
        openSettings: vi.fn(async () => undefined),
        sleep: async (ms: number) => {
            clock += ms;
        },
        now: () => clock
    };
}

describe("recording system audio on macOS", () => {
    it("is met once allowed, and before macOS 14.2, where there is nothing to allow", () => {
        expect(decideAudioCapture("ready")).toEqual({ state: "met", before: false });
        expect(decideAudioCapture("needsNewerMacos")).toEqual({ state: "met", before: false });
        expect(decideAudioCapture("notAsked")).toEqual({ state: "missing", before: false });
        expect(decideAudioCapture("notAllowed")).toEqual({ state: "missing", before: false });
    });

    it("asks once and is set up when the person allows it", async () => {
        const module = fakeModule(["notAsked", "notAsked", "notAsked", "ready"]);
        expect(await createAudioCaptureRunner(fakeDeps(module)).setUp()).toEqual({ ok: true });
        expect(module.requested).toBe(1);
    });

    it("a no is a declined setup, so the page offers it again", async () => {
        const module = fakeModule(["notAsked", "notAllowed"]);
        const runner = createAudioCaptureRunner(fakeDeps(module));
        expect(await runner.setUp()).toEqual({ ok: false, reason: "declined" });
        expect(await runner.look()).toEqual({ state: "missing", before: false });
    });

    it("after a no, the action opens System Settings and waits for the switch", async () => {
        const module = fakeModule(["notAllowed", "notAllowed", "ready"]);
        const deps = fakeDeps(module);
        expect(await createAudioCaptureRunner(deps).setUp()).toEqual({ ok: true });
        expect(deps.openSettings).toHaveBeenCalledOnce();
        expect(module.requested).toBe(0);
    });

    it("gives up after the wait when nobody answers", async () => {
        const deps = fakeDeps(fakeModule(["notAllowed"]));
        expect(await createAudioCaptureRunner(deps).setUp()).toEqual({ ok: false, reason: "declined" });
        expect(deps.now()).toBeGreaterThanOrEqual(ANSWER_WAIT_MS);
    });

    it("needs nothing before macOS 14.2 or once allowed", async () => {
        for (const access of ["needsNewerMacos", "ready"]) {
            const module = fakeModule([access]);
            expect(await createAudioCaptureRunner(fakeDeps(module)).setUp()).toEqual({ ok: true });
            expect(module.requested).toBe(0);
        }
    });

    it("cannot be told without the plugin's module", async () => {
        const runner = createAudioCaptureRunner(fakeDeps(null));
        await expect(runner.look()).rejects.toThrow();
        expect(await runner.setUp()).toEqual({ ok: false, reason: "failed" });
    });

    it("is known only for the Stream 100, only on macOS", () => {
        expect(audioCaptureRunnerFor("hercules-stream100", "/plugins", "darwin")).not.toBeNull();
        expect(audioCaptureRunnerFor("hercules-stream100", "/plugins", "linux")).toBeNull();
        expect(audioCaptureRunnerFor("another-plugin", "/plugins", "darwin")).toBeNull();
        expect(requirementRunnerFor("hercules-stream100", AUDIO_CAPTURE_REQUIREMENT, "/plugins", "win32")).toBeNull();
    });

    it("loads the installed version's module once, and nothing that lacks the calls", async () => {
        const dir = await mkdtemp(join(tmpdir(), "polaris-audio-capture-"));
        const installed = { schema: 1, plugins: { "hercules-stream100": { version: "0.1.16", enabled: true, granted: [], installedAt: "2026-11-27T00:00:00.000Z" } } };
        await writeFile(join(dir, "installed.json"), JSON.stringify(installed));
        const module = fakeModule(["ready"]);
        const load = vi.fn((_path: string) => module);
        const loader = installedModuleLoader(dir, "hercules-stream100", load);
        expect(await loader()).toBe(module);
        expect(await loader()).toBe(module);
        expect(load).toHaveBeenCalledOnce();
        expect(load.mock.calls[0]?.[0]).toBe(join(dir, "packages", "hercules-stream100", "0.1.16", "stream100.node"));
        expect(await installedModuleLoader(dir, "hercules-stream100", () => ({}))()).toBeNull();
        expect(await installedModuleLoader(dir, "hercules-stream100", () => {
            throw new Error("no");
        })()).toBeNull();
        expect(await installedModuleLoader(dir, "other", load)()).toBeNull();
    });
});
