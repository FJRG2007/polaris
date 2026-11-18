// @vitest-environment jsdom

/**
 * A shared screen's frame rate and resolution, chosen by the sharer.
 *
 * What is pinned: a preset is recognised whatever menu set it; a chosen shape
 * is what opens, encodes and tunes the share (not the ladder's rung); "Source"
 * names no size; nothing unreadable in storage reaches a constraint; and a
 * sharer who hid their own stream sees neither copy of it.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as quality from "@/app/(app)/chat/call-quality";
import { reshape } from "@/app/(app)/chat/share-stream-menu";
import { LOCAL_SCREEN_KEY, stagesOf } from "@/app/(app)/chat/call-media";
import {
    STREAM_PREFS_DEFAULT,
    STREAM_PRESETS,
    modeOf,
    setStreamPrefs,
    streamPrefs,
    streamRung
} from "@/app/(app)/chat/stream-shape";

afterEach(() => setStreamPrefs(STREAM_PREFS_DEFAULT));

describe("stream modes", () => {
    it("names a preset exactly, and anything else custom", () => {
        expect(modeOf(STREAM_PRESETS.gaming)).toBe("gaming");
        expect(modeOf({ frameRate: 5, resolution: "source" })).toBe("screenshare");
        expect(modeOf({ frameRate: 60, resolution: 720 })).toBe("custom");
    });

    it("changes one half of a shape, starting from Gaming when there was none", () => {
        expect(reshape(null, { frameRate: 60 })).toEqual({ frameRate: 60, resolution: 720 });
        expect(reshape({ frameRate: 5, resolution: "source" }, { resolution: 1080 })).toEqual({
            frameRate: 5,
            resolution: 1080
        });
    });

    it("turns a shape into a rung whose size, rate and bits move together", () => {
        expect(streamRung({ frameRate: 30, resolution: 720 })).toMatchObject({
            width: 1280,
            height: 720,
            frameRate: 30,
            maxBitrate: 2_500_000
        });
        const source = streamRung({ frameRate: 5, resolution: "source" });
        expect(source.width).toBeUndefined();
        expect(source.height).toBeUndefined();
        expect(streamRung({ frameRate: 60, resolution: 1080 }).maxBitrate).toBeGreaterThan(
            streamRung({ frameRate: 30, resolution: 1080 }).maxBitrate
        );
    });
});

describe("the share follows a chosen shape", () => {
    it("is the ladder's rung until a shape is chosen", () => {
        expect(quality.screenRung("low")).toBe(quality.SCREEN_LADDER.rungs.low);
        expect(quality.screenConstraints("high")).toEqual({
            width: { ideal: 1920 },
            frameRate: { ideal: 30 }
        });
    });

    it("opens, encodes and tunes by the shape once there is one", () => {
        setStreamPrefs({ shape: { frameRate: 60, resolution: 1440 } });
        expect(quality.screenConstraints("low")).toEqual({
            width: { ideal: 2560 },
            frameRate: { ideal: 60 }
        });
        expect(quality.screenEncoding("low").maxFramerate).toBe(60);
        expect(quality.screenTuning("low", false).hint).toBe("motion");
        setStreamPrefs({ shape: STREAM_PRESETS.screenshare });
        expect(quality.screenConstraints("max")).toEqual({ frameRate: { ideal: 5 } });
        expect(quality.screenTuning("max", false).hint).toBe("detail");
    });
});

describe("what is kept", () => {
    it("reads nothing it cannot vouch for", () => {
        const kept = new Map<string, string>();
        const storage = {
            getItem: (key: string) => kept.get(key) ?? null,
            setItem: (key: string, value: string) => void kept.set(key, value)
        };
        const before = Object.getOwnPropertyDescriptor(window, "localStorage");
        Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
        try {
            storage.setItem(
                "polaris.call.stream",
                JSON.stringify({ shape: { frameRate: 999, resolution: "8k" }, showOwn: "yes" })
            );
            expect(streamPrefs()).toEqual({ shape: null, showOwn: true, pauseUnfocused: false });
            storage.setItem(
                "polaris.call.stream",
                JSON.stringify({ shape: { frameRate: 15, resolution: 480 }, showOwn: false })
            );
            expect(streamPrefs()).toEqual({
                shape: { frameRate: 15, resolution: 480 },
                showOwn: false,
                pauseUnfocused: false
            });
            storage.setItem("polaris.call.stream", "{not json");
            expect(streamPrefs()).toEqual(STREAM_PREFS_DEFAULT);
        } finally {
            if (before) Object.defineProperty(window, "localStorage", before);
            else delete (window as { localStorage?: unknown }).localStorage;
        }
    });
});

describe("the sharer's own stream", () => {
    const words = { yourScreen: "Your screen", theirScreen: (name: string) => `${name} - screen` };
    const own = { label: "own" } as unknown as MediaStream;
    const echoed = { label: "echo" } as unknown as MediaStream;

    it("is drawn first, and the copy coming back from the server is not", () => {
        const stages = stagesOf({
            localScreen: own,
            participantId: "p1",
            screens: new Map([["p1", echoed]]),
            nameOf: () => "Ada",
            words
        });
        expect(stages.map((stage) => stage.key)).toEqual([LOCAL_SCREEN_KEY]);
    });

    it("is not drawn at all once hidden, in either copy", () => {
        const stages = stagesOf({
            localScreen: own,
            ownHidden: true,
            participantId: "p1",
            screens: new Map([
                ["p1", echoed],
                ["p2", echoed]
            ]),
            nameOf: () => "Ada",
            words
        });
        expect(stages.map((stage) => stage.key)).toEqual(["screen:p2"]);
    });
});
