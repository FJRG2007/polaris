// @vitest-environment jsdom

/**
 * A video is a slide in the same viewer as the pictures around it.
 *
 * It plays with its own controls and is never zoomed, so a press on it is never
 * taken for a pan; it fades in when opened, stops when it is stepped past, and
 * its menu is the caller's, drawn only when there is something in it. Pictures
 * keep everything they had: the zoom, the capture, the image menu.
 */

import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ImageViewer, type ViewedImage, type ViewerLabels, type ViewerMenu } from "../src/image-viewer/image-viewer";

const labels: ViewerLabels = {
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    more: "More for this picture",
    moreVideo: "More for this video",
    close: "Close",
    previous: "Previous",
    next: "Next",
    position: (index, count) => `${index} of ${count}`
};

const clip: ViewedImage = { url: "/files/clip.mp4", name: "clip.mp4", video: true, poster: "/files/clip.jpg" };
const photo: ViewedImage = { url: "/files/photo.png", name: "photo.png" };

/** The viewer as a caller holds it: open on one slide, stepping through a set. */
function Harness({ start, gallery, menu }: { start: ViewedImage; gallery: ViewedImage[]; menu?: ViewerMenu; }) {
    const [image, setImage] = useState<ViewedImage | null>(start);
    return (
        <ImageViewer
            image={image}
            gallery={gallery}
            onNavigate={setImage}
            onClose={() => setImage(null)}
            origin={() => null}
            labels={labels}
            menu={menu}
        />
    );
}

let animate: ReturnType<typeof vi.fn>;
let pause: ReturnType<typeof vi.fn>;
let capture: ReturnType<typeof vi.fn>;

beforeEach(() => {
    animate = vi.fn(() => ({ finished: Promise.resolve() }));
    pause = vi.fn();
    capture = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
    Object.defineProperty(HTMLMediaElement.prototype, "pause", { configurable: true, value: pause });
    Object.defineProperty(Element.prototype, "setPointerCapture", { configurable: true, value: capture });
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query }));
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

function videoElement(): HTMLVideoElement {
    const found = document.querySelector<HTMLVideoElement>("video[data-viewer-video]");
    if (!found) throw new Error("no video on screen");
    return found;
}

describe("a video slide", () => {
    it("plays with its own controls, inline, and offers no zoom", () => {
        render(<Harness start={clip} gallery={[clip]} />);
        const video = videoElement();
        expect(video.controls).toBe(true);
        expect(video.hasAttribute("playsinline")).toBe(true);
        expect(video.getAttribute("src")).toBe(clip.url);
        expect(video.getAttribute("poster")).toBe(clip.poster);
        expect(screen.queryByLabelText("Zoom in")).toBeNull();
        expect(document.querySelector("[data-viewer-picture]")).toBeNull();
    });

    it("never captures the pointer, even for two fingers", () => {
        render(<Harness start={clip} gallery={[clip]} />);
        const stage = videoElement().parentElement!;
        fireEvent.pointerDown(stage, { pointerId: 1, pointerType: "touch", clientX: 10, clientY: 10 });
        fireEvent.pointerDown(stage, { pointerId: 2, pointerType: "touch", clientX: 60, clientY: 60 });
        expect(capture).not.toHaveBeenCalled();
    });

    it("fades in when opened with no thumbnail to fly from", () => {
        render(<Harness start={clip} gallery={[clip]} />);
        const video = videoElement();
        const own = animate.mock.contexts.indexOf(video);
        expect(own).toBeGreaterThanOrEqual(0);
        expect(animate.mock.calls[own]?.[0]).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    });

    it("stops when it is stepped past, from the arrow button", () => {
        render(<Harness start={clip} gallery={[clip, photo]} />);
        const video = videoElement();
        fireEvent.click(screen.getByLabelText("Next"));
        expect(pause.mock.contexts).toContain(video);
        expect(document.querySelector("video")).toBeNull();
        expect(document.querySelector("[data-viewer-picture]")?.getAttribute("src")).toBe(photo.url);
    });

    it("steps on the arrow keys, except while the video itself has them for seeking", () => {
        render(<Harness start={clip} gallery={[clip, photo]} />);
        fireEvent.keyDown(videoElement(), { key: "ArrowRight" });
        expect(document.querySelector("video")).not.toBeNull();
        act(() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
        });
        expect(document.querySelector("video")).toBeNull();
    });

    it("draws the caller's menu for a video, and none when it has nothing to offer", () => {
        const menu: ViewerMenu = ({ image, Item }) =>
            image.video && image.downloadable !== false ? <Item>Download video</Item> : image.video ? null : <Item>Copy image</Item>;
        const { unmount } = render(<Harness start={clip} gallery={[clip]} menu={menu} />);
        expect(screen.getByLabelText("More for this video")).toBeTruthy();
        unmount();
        render(<Harness start={{ ...clip, downloadable: false }} gallery={[]} menu={menu} />);
        expect(screen.queryByLabelText("More for this video")).toBeNull();
        expect(screen.queryByLabelText("More for this picture")).toBeNull();
    });
});

describe("a picture slide, beside the videos", () => {
    it("keeps its zoom, its pinch capture and its menu", () => {
        const menu: ViewerMenu = ({ Item }) => <Item>Copy image</Item>;
        render(<Harness start={photo} gallery={[photo, clip]} menu={menu} />);
        expect(screen.getByLabelText("Zoom in")).toBeTruthy();
        expect(screen.getByLabelText("More for this picture")).toBeTruthy();
        const stage = document.querySelector("[data-viewer-picture]")!.parentElement!;
        fireEvent.pointerDown(stage, { pointerId: 1, pointerType: "touch", clientX: 10, clientY: 10 });
        fireEvent.pointerDown(stage, { pointerId: 2, pointerType: "touch", clientX: 60, clientY: 60 });
        expect(capture).toHaveBeenCalled();
    });

    it("steps onto a video and slides it in from that side", () => {
        render(<Harness start={photo} gallery={[photo, clip]} />);
        fireEvent.click(screen.getByLabelText("Next"));
        const video = videoElement();
        const own = animate.mock.contexts.indexOf(video);
        expect(animate.mock.calls[own]?.[0]).toEqual([
            { opacity: 0, translate: "48px 0" },
            { opacity: 1, translate: "0 0" }
        ]);
    });
});
