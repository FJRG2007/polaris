// @vitest-environment jsdom

/**
 * The player every recording in Polaris is drawn with.
 *
 * Two things are worth holding still. The element underneath keeps `controls`,
 * so a browser that never loads the player - a stale chunk, a network that went
 * away - is left with its own rather than with a rectangle that does nothing.
 * And the source is the element's key, because Plyr is built against the element
 * it was handed: giving that element a different file underneath it leaves the
 * controls describing the previous one.
 */

import { MediaPlayer } from "@/components/media-player";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

afterEach(cleanup);

describe("the media player", () => {
    it("draws a video that still works without the player", () => {
        const { container } = render(<MediaPlayer src="/api/home/clips/c1/video" kind="video" />);
        const video = container.querySelector("video");
        expect(video?.getAttribute("src")).toBe("/api/home/clips/c1/video");
        expect(video?.hasAttribute("controls")).toBe(true);
        expect(video?.hasAttribute("playsinline")).toBe(true);
    });

    it("draws an audio element for a recording", () => {
        const { container } = render(<MediaPlayer src="/api/drive/x/audio.mp3" kind="audio" />);
        expect(container.querySelector("audio")).not.toBeNull();
        expect(container.querySelector("video")).toBeNull();
    });

    it("only autoplays where the screen asked for it", () => {
        const { container } = render(<MediaPlayer src="/a.mp4" kind="video" />);
        expect(container.querySelector("video")?.hasAttribute("autoplay")).toBe(false);

        cleanup();
        const playing = render(<MediaPlayer src="/a.mp4" kind="video" autoPlay />);
        expect(playing.container.querySelector("video")?.hasAttribute("autoplay")).toBe(true);
    });

    it("carries the accent as a token rather than a colour", () => {
        const { container } = render(<MediaPlayer src="/a.mp4" kind="video" />);
        const frame = container.firstElementChild as HTMLElement | null;
        expect(frame?.style.getPropertyValue("--plyr-color-main")).toBe("hsl(var(--primary))");
    });
});
