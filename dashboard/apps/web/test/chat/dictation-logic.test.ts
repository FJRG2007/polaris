/**
 * The composer's mic decisions: which button ends the box, what a press means,
 * which engine dictates, which attach items a room offers, and the words for
 * every problem in both languages.
 */

import * as core from "@polaris/core";
import { webCatalogs } from "../../messages";
import { describe, expect, it } from "vitest";
import * as logic from "@/app/(app)/chat/dictation-logic";

const box = { editing: false, blank: true, staged: false, micAvailable: true, dictating: false };

describe("the mic and Send slot", () => {
    it("shows the mic on an empty box and Send once there is something to send", () => {
        expect(logic.composerSlot(box)).toBe("mic");
        expect(logic.composerSlot({ ...box, blank: false })).toBe("send");
        expect(logic.composerSlot({ ...box, staged: true })).toBe("send");
    });

    it("keeps Save while editing and Send where there is no mic", () => {
        expect(logic.composerSlot({ ...box, editing: true })).toBe("send");
        expect(logic.composerSlot({ ...box, micAvailable: false })).toBe("send");
    });

    it("keeps the stop button beside Send while dictation fills the box", () => {
        expect(logic.composerSlot({ ...box, dictating: true })).toBe("mic");
        expect(logic.composerSlot({ ...box, dictating: true, blank: false })).toBe("both");
    });
});

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
        expect(logic.dictationEngine({ browser: true, private: true, preferPrivate: false })).toBe("browser");
        expect(logic.dictationEngine({ browser: true, private: true, preferPrivate: true })).toBe("private");
        expect(logic.dictationEngine({ browser: false, private: true, preferPrivate: false })).toBe("private");
    });

    it("ignores the switch when Polaris cannot transcribe, and has none with neither", () => {
        expect(logic.dictationEngine({ browser: true, private: false, preferPrivate: true })).toBe("browser");
        expect(logic.dictationEngine({ browser: false, private: false, preferPrivate: true })).toBeNull();
    });

    it("sends a chunk at a pause after speech, or when it runs long", () => {
        expect(logic.chunkReady({ heard: false, quietMs: 5000, chunkMs: 5000 })).toBe(false);
        expect(logic.chunkReady({ heard: true, quietMs: logic.PAUSE_MS - 1, chunkMs: 1000 })).toBe(false);
        expect(logic.chunkReady({ heard: true, quietMs: logic.PAUSE_MS, chunkMs: 1000 })).toBe(true);
        expect(logic.chunkReady({ heard: true, quietMs: 0, chunkMs: logic.LONGEST_CHUNK_MS })).toBe(true);
    });
});

describe("the attach menu", () => {
    const room = {
        mayAttach: true,
        handheld: false,
        clippable: true,
        inCall: false,
        poll: true,
        micMenu: true
    };

    it("lists every item a computer allows, without a camera or a mic entry", () => {
        expect(logic.attachItems(room)).toEqual(["file", "gallery", "clip", "poll"]);
    });

    it("adds the camera and the mic menu on a phone", () => {
        expect(logic.attachItems({ ...room, handheld: true, clippable: false })).toEqual([
            "file",
            "gallery",
            "camera",
            "poll",
            "mic"
        ]);
    });

    it("hides what the room does not allow", () => {
        expect(logic.attachItems({ ...room, mayAttach: false })).toEqual(["poll"]);
        expect(logic.attachItems({ ...room, inCall: true })).toEqual(["file", "gallery", "poll"]);
        expect(logic.attachItems({ ...room, mayAttach: false, poll: false, micMenu: false })).toEqual([]);
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

    it("maps Polaris's transcription codes", () => {
        expect(logic.privateProblem("no_voice_provider")).toBe("notSetUp");
        expect(logic.privateProblem("usage_limit")).toBe("tooMany");
        expect(logic.privateProblem("transcribe_failed")).toBe("failed");
    });

    it("has a sentence for each, in English and Spanish", () => {
        for (const locale of ["en-US", "es-ES"] as const) {
            const t = webCatalogs.translator(locale, "chat");
            for (const key of Object.values(logic.PROBLEM_KEYS)) {
                const said = t(key);
                expect(said).not.toBe(key);
                expect(said.length).toBeGreaterThan(10);
            }
        }
        expect(webCatalogs.translator("es-ES", "chat")("dictation.start")).toBe("Dictar");
        expect(webCatalogs.translator("es-ES", "chat")("attachMenu.add")).toBe("Añadir");
    });
});

describe("the dictation key", () => {
    it("is Alt+M, and takes no key another chat action holds", () => {
        const bindings = core.resolveShortcuts();
        expect(core.keysOf(bindings, "chat.dictate")).toEqual(["Alt+m"]);
        expect(core.shortcutConflicts(bindings)).toEqual([]);
    });
});
