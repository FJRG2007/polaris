/**
 * The share button's menu while a screen is going out.
 *
 * What is asserted is what somebody watching would notice: a change of stream
 * never takes the picture's publication down, closing the picker leaves the
 * share as it was, the sound comes and goes on its own, and a new quality rung
 * reaches the encoder without publishing again.
 */

import { describe, expect, it, vi } from "vitest";
import {
    retargetEncodings,
    retuneScreenEncoding,
    shareMenuRows,
    sharePress,
    swapScreen,
    type EncodedTrack
} from "@/app/(app)/chat/call-share-menu";

function fakeTrack(kind: "video" | "audio", id: string): MediaStreamTrack {
    return { kind, id, stop: vi.fn() } as unknown as MediaStreamTrack;
}

function fakeStream(video: MediaStreamTrack | null, audio: MediaStreamTrack | null): MediaStream {
    return {
        getVideoTracks: () => (video ? [video] : []),
        getAudioTracks: () => (audio ? [audio] : [])
    } as unknown as MediaStream;
}

function named(name: string): Error {
    const error = new Error(name);
    error.name = name;
    return error;
}

describe("sharePress", () => {
    it("starts a share when none is running", () => {
        expect(sharePress({ sharing: false, canShare: true })).toBe("start");
    });

    it("opens the menu while sharing", () => {
        expect(sharePress({ sharing: true, canShare: true })).toBe("menu");
        expect(sharePress({ sharing: true, canShare: false })).toBe("menu");
    });

    it("does nothing where the browser cannot share", () => {
        expect(sharePress({ sharing: false, canShare: false })).toBe("none");
    });
});

describe("shareMenuRows", () => {
    const base = { canShare: true, hasAudio: true, audioOn: true, changing: false };

    it("ticks the sound box while the sound goes out", () => {
        expect(shareMenuRows(base).audio).toEqual({ checked: true, disabled: false, reason: null });
        expect(shareMenuRows({ ...base, audioOn: false }).audio.checked).toBe(false);
    });

    it("locks the sound box with the reason when the share has no sound", () => {
        expect(shareMenuRows({ ...base, hasAudio: false }).audio).toEqual({
            checked: false,
            disabled: true,
            reason: "no-sound"
        });
    });

    it("offers a change only where there is a picker, and not twice at once", () => {
        expect(shareMenuRows(base).change.disabled).toBe(false);
        expect(shareMenuRows({ ...base, canShare: false }).change.disabled).toBe(true);
        expect(shareMenuRows({ ...base, changing: true }).change.disabled).toBe(true);
    });
});

describe("swapScreen", () => {
    function setup(current: { audio: MediaStreamTrack | null }) {
        const video = fakeTrack("video", "old-video");
        const publishVideo = vi.fn(async () => true);
        const publishAudio = vi.fn(async () => true);
        return {
            current: { video, audio: current.audio },
            publishVideo,
            publishAudio
        };
    }

    it("keeps the current share untouched when the picker is cancelled", async () => {
        const deps = setup({ audio: fakeTrack("audio", "old-audio") });
        const result = await swapScreen({
            ...deps,
            open: () => Promise.reject(named("NotAllowedError"))
        });
        expect(result).toEqual({ kind: "kept" });
        expect(deps.publishVideo).not.toHaveBeenCalled();
        expect(deps.publishAudio).not.toHaveBeenCalled();
        expect(deps.current.video.stop).not.toHaveBeenCalled();
        expect(deps.current.audio?.stop).not.toHaveBeenCalled();
    });

    it("treats an aborted picker as a cancel too", async () => {
        const deps = setup({ audio: null });
        const result = await swapScreen({
            ...deps,
            open: () => Promise.reject(named("AbortError"))
        });
        expect(result.kind).toBe("kept");
    });

    it("reports a real failure and keeps the share", async () => {
        const deps = setup({ audio: null });
        const result = await swapScreen({
            ...deps,
            open: () => Promise.reject(named("NotReadableError"))
        });
        expect(result.kind).toBe("failed");
        expect(deps.current.video.stop).not.toHaveBeenCalled();
    });

    it("swaps the picture in place and never unpublishes it", async () => {
        const deps = setup({ audio: null });
        const next = fakeTrack("video", "new-video");
        const result = await swapScreen({ ...deps, open: async () => fakeStream(next, null) });
        expect(result).toEqual({ kind: "swapped", tracks: { video: next, audio: null } });
        expect(deps.publishVideo).toHaveBeenCalledTimes(1);
        expect(deps.publishVideo).toHaveBeenCalledWith(next);
        // No sound before or after: the sound's publication is left alone.
        expect(deps.publishAudio).not.toHaveBeenCalled();
        expect(deps.current.video.stop).toHaveBeenCalledTimes(1);
        expect(next.stop).not.toHaveBeenCalled();
    });

    it("stops the old picture only after the new one is up", async () => {
        const deps = setup({ audio: null });
        const order: string[] = [];
        deps.publishVideo.mockImplementation(async () => {
            order.push("publish");
            return true;
        });
        (deps.current.video.stop as ReturnType<typeof vi.fn>).mockImplementation(() =>
            order.push("stop")
        );
        await swapScreen({
            ...deps,
            open: async () => fakeStream(fakeTrack("video", "new-video"), null)
        });
        expect(order).toEqual(["publish", "stop"]);
    });

    it("publishes the sound when the new pick has some and the old had none", async () => {
        const deps = setup({ audio: null });
        const sound = fakeTrack("audio", "new-audio");
        await swapScreen({
            ...deps,
            open: async () => fakeStream(fakeTrack("video", "new-video"), sound)
        });
        expect(deps.publishAudio).toHaveBeenCalledWith(sound);
        expect(deps.publishVideo).toHaveBeenCalledTimes(1);
    });

    it("takes the sound down when the new pick has none, picture untouched", async () => {
        const oldSound = fakeTrack("audio", "old-audio");
        const deps = setup({ audio: oldSound });
        const next = fakeTrack("video", "new-video");
        await swapScreen({ ...deps, open: async () => fakeStream(next, null) });
        expect(deps.publishAudio).toHaveBeenCalledWith(null);
        expect(deps.publishVideo).toHaveBeenCalledWith(next);
        expect(deps.publishVideo).not.toHaveBeenCalledWith(null);
        expect(oldSound.stop).toHaveBeenCalledTimes(1);
    });

    it("swaps sound for sound", async () => {
        const oldSound = fakeTrack("audio", "old-audio");
        const deps = setup({ audio: oldSound });
        const sound = fakeTrack("audio", "new-audio");
        await swapScreen({
            ...deps,
            open: async () => fakeStream(fakeTrack("video", "new-video"), sound)
        });
        expect(deps.publishAudio).toHaveBeenCalledWith(sound);
        expect(oldSound.stop).toHaveBeenCalledTimes(1);
        expect(sound.stop).not.toHaveBeenCalled();
    });

    it("keeps the old share when the new picture could not be sent", async () => {
        const deps = setup({ audio: null });
        deps.publishVideo.mockResolvedValue(false);
        const next = fakeTrack("video", "new-video");
        const sound = fakeTrack("audio", "new-audio");
        const result = await swapScreen({ ...deps, open: async () => fakeStream(next, sound) });
        expect(result.kind).toBe("failed");
        expect(deps.current.video.stop).not.toHaveBeenCalled();
        expect(next.stop).toHaveBeenCalled();
        expect(sound.stop).toHaveBeenCalled();
        expect(deps.publishAudio).not.toHaveBeenCalled();
    });

    it("opens the picker before awaiting anything", () => {
        const deps = setup({ audio: null });
        const open = vi.fn(() => new Promise<MediaStream>(() => undefined));
        void swapScreen({ ...deps, open });
        expect(open).toHaveBeenCalledTimes(1);
    });
});

describe("retargetEncodings", () => {
    it("gives the top layer the rung and caps the smaller ones", () => {
        const next = retargetEncodings(
            [
                { rid: "q", maxBitrate: 500_000, maxFramerate: 15 },
                { rid: "f", maxBitrate: 3_000_000, maxFramerate: 15 }
            ],
            { maxBitrate: 800_000, maxFramerate: 5 }
        );
        expect(next[1]).toMatchObject({ maxBitrate: 800_000, maxFramerate: 5 });
        expect(next[0]).toMatchObject({ maxBitrate: 500_000, maxFramerate: 5 });
    });

    it("leaves a switched-off layer as the client set it", () => {
        const next = retargetEncodings(
            [
                { rid: "q", active: false, maxBitrate: 10, maxFramerate: 2 },
                { rid: "f", maxBitrate: 3_000_000, maxFramerate: 15 }
            ],
            { maxBitrate: 6_000_000, maxFramerate: 30 }
        );
        expect(next[0]).toMatchObject({ active: false, maxBitrate: 10, maxFramerate: 2 });
        expect(next[1]).toMatchObject({ maxBitrate: 6_000_000, maxFramerate: 30 });
    });
});

describe("retuneScreenEncoding", () => {
    function published(encodings: RTCRtpEncodingParameters[], refuse = false) {
        const setParameters = vi.fn(async () => {
            if (refuse) throw named("InvalidModificationError");
        });
        const track: EncodedTrack = {
            sender: {
                getParameters: () => ({ encodings }),
                setParameters
            } as unknown as RTCRtpSender,
            publishOptions: { screenShareEncoding: { maxBitrate: 3_000_000, maxFramerate: 15 } },
            setDegradationPreference: vi.fn(async () => undefined)
        };
        return { track, setParameters };
    }

    it("applies the rung to the live sender without publishing again", async () => {
        const { track, setParameters } = published([{ maxBitrate: 3_000_000, maxFramerate: 15 }]);
        const want = { maxBitrate: 6_000_000, maxFramerate: 30 };
        expect(await retuneScreenEncoding(track, want, "maintain-framerate")).toBe(true);
        expect(setParameters).toHaveBeenCalledWith({
            encodings: [{ maxBitrate: 6_000_000, maxFramerate: 30 }]
        });
        // Kept for the client's own recompute after a change of stream.
        expect(track.publishOptions?.screenShareEncoding).toEqual(want);
        expect(track.setDegradationPreference).toHaveBeenCalledWith("maintain-framerate");
    });

    it("says so when the browser refuses, so the caller can publish again", async () => {
        const { track } = published([{ maxBitrate: 3_000_000 }], true);
        expect(
            await retuneScreenEncoding(
                track,
                { maxBitrate: 800_000, maxFramerate: 5 },
                "maintain-resolution"
            )
        ).toBe(false);
        expect(track.publishOptions?.screenShareEncoding?.maxBitrate).toBe(3_000_000);
    });

    it("says so when nothing is published yet", async () => {
        expect(
            await retuneScreenEncoding(
                undefined,
                { maxBitrate: 800_000, maxFramerate: 5 },
                "maintain-resolution"
            )
        ).toBe(false);
        expect(
            await retuneScreenEncoding(
                {},
                { maxBitrate: 800_000, maxFramerate: 5 },
                "maintain-resolution"
            )
        ).toBe(false);
    });
});
