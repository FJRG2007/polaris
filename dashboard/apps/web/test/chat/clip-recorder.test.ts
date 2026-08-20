// @vitest-environment jsdom

/**
 * What a browser will let Polaris record a screen into.
 *
 * The part worth pinning is the negotiation, because getting it wrong is
 * invisible until somebody presses the button: a container the browser cannot
 * record throws at `new MediaRecorder`, and a button offered where screens
 * cannot be shared at all - every phone - is a button that can only apologise.
 *
 * The name matters for the same reason it does for a voice message: it is what
 * the other person sees in the room, and an extension that does not match the
 * bytes is a file their player refuses.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { canRecordClip, clipFileName, clipRecordingType } from "@/app/(app)/chat/clip-recorder";

/** A browser that records exactly these types and nothing else. */
function browserRecording(types: readonly string[]) {
    vi.stubGlobal("MediaRecorder", {
        isTypeSupported: (type: string) => types.includes(type)
    });
}

/** Whether this browser can be asked for a screen at all. */
function canShareScreen(yes: boolean) {
    vi.stubGlobal("navigator", {
        mediaDevices: yes ? { getDisplayMedia: () => undefined } : {}
    });
}

afterEach(() => vi.unstubAllGlobals());

describe("what it records into", () => {
    it("takes the one the person receiving it can open, not the smallest", () => {
        browserRecording([
            "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
            "video/webm;codecs=vp9,opus",
            "video/webm"
        ]);
        // WebM with VP9 is a third smaller for the same picture and is the wrong
        // default anyway: a `.webm` opens in almost no desktop player and in no
        // video editor, and recording straight into MP4 is the only honest way
        // to hand somebody one - converting a video in a page means shipping a
        // transcoder.
        expect(clipRecordingType()).toBe("video/mp4;codecs=avc1.42E01E,mp4a.40.2");
    });

    it("falls back through the containers rather than assuming one", () => {
        browserRecording(["video/webm"]);
        expect(clipRecordingType()).toBe("video/webm");
        browserRecording(["video/mp4"]);
        expect(clipRecordingType()).toBe("video/mp4");
        browserRecording(["video/webm;codecs=vp9,opus", "video/webm"]);
        expect(clipRecordingType()).toBe("video/webm;codecs=vp9,opus");
    });

    it("answers nothing for a browser that records no video at all", () => {
        browserRecording([]);
        expect(clipRecordingType()).toBeNull();
        expect(canRecordClip()).toBe(false);
    });
});

describe("whether the button exists", () => {
    it("needs a screen to share as well as a recorder", () => {
        browserRecording(["video/webm"]);
        canShareScreen(true);
        expect(canRecordClip()).toBe(true);

        // Every phone: it records sound perfectly well and cannot share a screen.
        canShareScreen(false);
        expect(canRecordClip()).toBe(false);
    });
});

describe("what it is called", () => {
    it("matches the bytes, so the other end plays it", () => {
        expect(clipFileName("video/webm;codecs=vp9,opus")).toBe("screen-clip.webm");
        expect(clipFileName("video/mp4")).toBe("screen-clip.mp4");
    });
});
