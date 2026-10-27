/**
 * The composer's mic decisions: what a press means, which engine dictates,
 * when the browser's recognizer is given up on, and the words for every
 * problem in both languages.
 */

import * as core from "@polaris/core";
import { webCatalogs } from "../../messages";
import { describe, expect, it, vi } from "vitest";
import * as logic from "@/app/(app)/chat/dictation-logic";

describe("tap and hold", () => {
    it("tells a tap from a hold by time", () => {
        expect(logic.isHold(0, logic.HOLD_MS - 1)).toBe(false);
        expect(logic.isHold(0, logic.HOLD_MS)).toBe(true);
    });

    it("dictates on a tap and records on a hold", () => {
        const both = { engine: "browser" as const, voiceAllowed: true };
        expect(logic.tapAction(both)).toBe("dictate");
        expect(logic.holdAction(both)).toBe("voice");
    });

    it("records on a tap where there is no engine, so the mic is never dead", () => {
        expect(logic.tapAction({ engine: null, voiceAllowed: true })).toBe("voice");
        expect(logic.tapAction({ engine: null, voiceAllowed: false })).toBeNull();
    });

    it("dictates on a hold where no voice message may be sent", () => {
        expect(logic.holdAction({ engine: "private", voiceAllowed: false })).toBe("dictate");
    });

    it("cancels on a slide left and locks on a slide up, left first", () => {
        expect(logic.slideOutcome(-10, -10)).toBeNull();
        expect(logic.slideOutcome(-90, 0)).toBe("cancel");
        expect(logic.slideOutcome(0, -70)).toBe("lock");
        expect(logic.slideOutcome(-90, -70)).toBe("cancel");
    });
});

describe("the dictation engine", () => {
    it("prefers the browser, and Polaris when chosen or the only one", () => {
        expect(logic.dictationEngine({ browser: true, private: true, preferPrivate: false })).toBe(
            "browser"
        );
        expect(logic.dictationEngine({ browser: true, private: true, preferPrivate: true })).toBe(
            "private"
        );
        expect(logic.dictationEngine({ browser: false, private: true, preferPrivate: false })).toBe(
            "private"
        );
    });

    it("ignores the switch when Polaris cannot transcribe, and has none with neither", () => {
        expect(logic.dictationEngine({ browser: true, private: false, preferPrivate: true })).toBe(
            "browser"
        );
        expect(
            logic.dictationEngine({ browser: false, private: false, preferPrivate: true })
        ).toBeNull();
    });

    it("sends a chunk at a pause after speech, or when it runs long", () => {
        expect(logic.chunkReady({ heard: false, quietMs: 5000, chunkMs: 5000 })).toBe(false);
        expect(logic.chunkReady({ heard: true, quietMs: logic.PAUSE_MS - 1, chunkMs: 1000 })).toBe(
            false
        );
        expect(logic.chunkReady({ heard: true, quietMs: logic.PAUSE_MS, chunkMs: 1000 })).toBe(
            true
        );
        expect(logic.chunkReady({ heard: true, quietMs: 0, chunkMs: logic.LONGEST_CHUNK_MS })).toBe(
            true
        );
    });
});

describe("dictation problems", () => {
    it("maps the browser's error codes, staying quiet on a stop that was asked for", () => {
        expect(logic.browserProblem("aborted")).toBeNull();
        expect(logic.browserProblem("not-allowed")).toBe("micBlocked");
        expect(logic.browserProblem("service-not-allowed")).toBe("serviceBlocked");
        expect(logic.browserProblem("network")).toBe("network");
        expect(logic.browserProblem("audio-capture")).toBe("noMic");
        expect(logic.browserProblem("something-new")).toBe("failed");
    });

    it("gives up on the browser's recognizer only where it will fail again", () => {
        expect(logic.browserUnusable("network", true)).toBe(true);
        expect(logic.browserUnusable("service-not-allowed", true)).toBe(true);
        expect(logic.browserUnusable("not-allowed", true)).toBe(false);
        expect(logic.browserUnusable("no-speech", true)).toBe(false);
    });

    it("keeps a network error while offline an error, not a switch", () => {
        expect(logic.browserUnusable("network", false)).toBe(false);
        expect(logic.browserUnusable("service-not-allowed", false)).toBe(true);
    });

    it("passes over a failed recognizer for a day, not for good", () => {
        const stored = new Map<string, string>();
        vi.stubGlobal("window", {
            localStorage: {
                getItem: (key: string) => stored.get(key) ?? null,
                setItem: (key: string, value: string) => void stored.set(key, value)
            }
        });
        const at = 1_800_000_000_000;
        expect(logic.browserSpeechUnusable(at)).toBe(false);
        logic.markBrowserSpeechUnusable(at);
        expect(logic.browserSpeechUnusable(at + logic.BROWSER_UNUSABLE_MS - 1)).toBe(true);
        expect(logic.browserSpeechUnusable(at + logic.BROWSER_UNUSABLE_MS)).toBe(false);
        stored.set("polaris.chat.dictation-browser-unusable", "1");
        expect(logic.browserSpeechUnusable(at)).toBe(false);
        vi.unstubAllGlobals();
    });

    it("maps Polaris's transcription codes", () => {
        expect(logic.privateProblem("no_voice_provider")).toBe("notSetUp");
        expect(logic.privateProblem("usage_limit")).toBe("tooMany");
        expect(logic.privateProblem("transcribe_failed")).toBe("failed");
    });

    it("points at the Private dictation switch only where the mic menu has it", () => {
        expect(logic.problemKey("network", true)).toBe("dictation.problemWithPrivate.network");
        expect(logic.problemKey("network", false)).toBe("dictation.problem.network");
        expect(logic.problemKey("notSetUp", false)).toBe("dictation.problem.notSetUp");
        expect(logic.problemKey("tooMany", true)).toBe("dictation.problem.tooMany");
        const t = webCatalogs.translator("en-US", "chat");
        for (const problem of Object.keys(
            logic.PROBLEM_KEYS
        ) as (keyof typeof logic.PROBLEM_KEYS)[]) {
            expect(t(logic.problemKey(problem, false))).not.toMatch(/Private dictation|set up/i);
        }
    });

    it("has a sentence for each, in English and Spanish", () => {
        for (const locale of ["en-US", "es-ES"] as const) {
            const t = webCatalogs.translator(locale, "chat");
            for (const key of [
                ...Object.values(logic.PROBLEM_KEYS),
                ...Object.values(logic.PRIVATE_SWITCH_KEYS)
            ]) {
                const said = t(key);
                expect(said).not.toBe(key);
                expect(said.length).toBeGreaterThan(10);
            }
        }
        expect(webCatalogs.translator("es-ES", "chat")("dictation.start")).toBe("Dictar");
    });
});

describe("the dictation key", () => {
    it("is Alt+M, and takes no key another chat action holds", () => {
        const bindings = core.resolveShortcuts();
        expect(core.keysOf(bindings, "chat.dictate")).toEqual(["Alt+m"]);
        expect(core.shortcutConflicts(bindings)).toEqual([]);
    });
});
