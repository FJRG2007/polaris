/**
 * macOS: recording system audio, which the Stream 100's per-app volume needs.
 * Its knobs set an app's volume through a Core Audio process tap (macOS 14.2
 * and later, `crates/polaris-stream100/src/native/macos.rs`), and macOS taps
 * an app only for a program the person allowed to record system audio.
 *
 * The manifest lists it under `requires` for darwin-x64 and darwin-arm64, so
 * it is set up like the Windows driver and the Linux udev rule
 * (`requirements.ts`): consented to with the install, then macOS asks once;
 * offered on the page when it was never consented to or the person said no.
 * Once answered macOS never asks again, so a "no" opens the System Settings
 * pane where it is turned on, and the page action stays until it is.
 *
 * The prompt is asked for from this (the app's main) process, whose bundle
 * declares `NSAudioCaptureUsageDescription` (forge.config.js); the plugin only
 * reads the answer. Both go through the plugin's own native module, the one
 * place that speaks to Core Audio, loaded from the installed package.
 */
import { join } from "node:path";
import { createRequire } from "node:module";
import { packageDir, readInstalled } from "./packages";
import type { RequirementLook, RequirementOutcome, RequirementRunner } from "./requirements";

/** `audioAccess()` of the plugin's module: `ready`, `notAsked`, `notAllowed` or `needsNewerMacos`. */
export interface AudioAccessModule {
    audioAccess(): string;
    requestAudioAccess(): void;
}

/** The System Settings pane that holds "System Audio Recording Only" (Privacy & Security). */
export const AUDIO_CAPTURE_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

/** How long a setup waits for the person to answer the prompt or flip the switch. */
export const ANSWER_WAIT_MS = 120_000;
const POLL_MS = 500;

export interface AudioCaptureDeps {
    /** The installed plugin's module, or null (not installed, or it does not load here). */
    load(): Promise<AudioAccessModule | null>;
    openSettings(): Promise<void>;
    sleep(ms: number): Promise<void>;
    now(): number;
}

/** Met once allowed, and before 14.2 too: there is nothing to allow there, and the page header says per-app volume needs 14.2. */
export function decideAudioCapture(access: string): RequirementLook {
    if (access === "ready" || access === "needsNewerMacos") return { state: "met", before: false };
    return { state: "missing", before: false };
}

function read(module: AudioAccessModule): string {
    try {
        return module.audioAccess();
    } catch {
        return "notAsked";
    }
}

export function createAudioCaptureRunner(deps: AudioCaptureDeps): RequirementRunner {
    async function waitFor(module: AudioAccessModule, done: (access: string) => boolean): Promise<string> {
        const until = deps.now() + ANSWER_WAIT_MS;
        let access = read(module);
        while (!done(access) && deps.now() < until) {
            await deps.sleep(POLL_MS);
            access = read(module);
        }
        return access;
    }

    return {
        async look() {
            const module = await deps.load();
            if (!module) throw new Error("the Stream 100 module is not here");
            return decideAudioCapture(read(module));
        },
        async setUp(): Promise<RequirementOutcome> {
            const module = await deps.load();
            if (!module) return { ok: false, reason: "failed" };
            const before = read(module);
            if (before === "ready" || before === "needsNewerMacos") return { ok: true };
            if (before === "notAsked") {
                module.requestAudioAccess();
                const answered = await waitFor(module, (access) => access !== "notAsked");
                if (answered === "ready") return { ok: true };
                // Declined just now: macOS will not ask again, so the page's action opens the switch.
                return { ok: false, reason: "declined" };
            }
            await deps.openSettings();
            const after = await waitFor(module, (access) => access === "ready");
            return after === "ready" ? { ok: true } : { ok: false, reason: "declined" };
        }
    };
}

/** The installed Stream 100 package's native module, loaded once per installed version. */
export function installedModuleLoader(pluginsDir: string, id: string, load: (path: string) => unknown = createRequire(__filename)): () => Promise<AudioAccessModule | null> {
    const loaded = new Map<string, AudioAccessModule | null>();
    return async () => {
        const version = (await readInstalled(pluginsDir)).plugins[id]?.version;
        if (!version) return null;
        const path = join(packageDir(pluginsDir, id, version), "stream100.node");
        if (!loaded.has(path)) {
            let module: AudioAccessModule | null = null;
            try {
                const value = load(path) as Partial<AudioAccessModule> | null;
                if (value && typeof value.audioAccess === "function" && typeof value.requestAudioAccess === "function") module = value as AudioAccessModule;
            } catch {
                module = null;
            }
            loaded.set(path, module);
        }
        return loaded.get(path) ?? null;
    };
}
