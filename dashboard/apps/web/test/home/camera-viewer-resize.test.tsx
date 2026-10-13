// @vitest-environment jsdom

/**
 * The viewer following a stream that changes resolution in-band, with no
 * decoded frame to measure and no still known.
 *
 * `measureVideo` used to fold the new report into whatever shape was already
 * known, and once anything was known - even a shape measured off a stream
 * report rather than a still - that value outranked a fresh resize report
 * forever. A camera that started at 1280x720 and then switched to 640x480 kept
 * drawing the old 16:9 box over a 4:3 picture, the same stretch this whole
 * feature exists to prevent, just reached from the resize path instead of the
 * declared-pixel-shape path. The fix tracks the still's shape on its own, so a
 * resize is followed whenever there is nothing more trustworthy to prefer.
 */

import "@/components/app-host/client";
import { withMessages } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CameraView } from "@polaris-app/places/src/lib/cameras";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { CameraViewer } from "@polaris-app/places/src/screens/camera-viewer";

function camera(overrides: Partial<CameraView> = {}): CameraView {
    return {
        id: "cam-1",
        name: "Front door",
        placeId: "place",
        zone: "Porch",
        vendor: "tapo",
        model: null,
        modelId: "",
        power: "mains",
        address: "192.0.2.1",
        rtspPort: 554,
        onvifPort: null,
        mainPath: "",
        subPath: "",
        username: "",
        hasPassword: false,
        reachVia: "local",
        detector: "none",
        detectorTargetId: null,
        detection: { sensitivity: 50, settleSeconds: 2, minGapSeconds: 30 },
        recording: "off",
        storageTarget: "",
        retentionDays: 30,
        enabled: true,
        ptz: false,
        lastSeenAt: null,
        offlineSince: null,
        ...overrides
    };
}

beforeEach(() => {
    // jsdom neither plays media nor observes layout.
    HTMLMediaElement.prototype.play = async () => undefined;
    HTMLMediaElement.prototype.pause = () => undefined;
    HTMLMediaElement.prototype.load = () => undefined;
    globalThis.ResizeObserver = class {
        observe() {}
        disconnect() {}
        unobserve() {}
    } as unknown as typeof ResizeObserver;
});

afterEach(() => cleanup());

function setVideoSize(video: HTMLVideoElement, width: number, height: number) {
    Object.defineProperty(video, "videoWidth", { configurable: true, value: width });
    Object.defineProperty(video, "videoHeight", { configurable: true, value: height });
    // >= 2 (HAVE_CURRENT_DATA): what lets `measureVideo` trust the report at
    // all once no decoded frame can be read (jsdom has no `VideoFrame`).
    Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
}

/** jsdom serializes the CSS `aspect-ratio` shorthand as "<ratio> / 1" rather
 *  than handing the number straight back. */
function drawnShape(video: HTMLVideoElement): number {
    return Number.parseFloat(video.style.aspectRatio);
}

describe("the camera viewer, following a stream that resizes in-band", () => {
    it("follows a resize report rather than freezing on the shape first measured", async () => {
        render(
            withMessages(<CameraViewer camera={camera()} canControl={false} onClose={() => {}} />)
        );
        await act(async () => {
            await Promise.resolve();
        });

        // The dialog portals its content onto `document.body` rather than into
        // the render container.
        const video = document.body.querySelector("video");
        if (!video) throw new Error("no video element rendered");

        setVideoSize(video, 1280, 720);
        await act(async () => {
            fireEvent(video, new Event("loadeddata"));
        });
        expect(drawnShape(video)).toBeCloseTo(16 / 9);

        setVideoSize(video, 640, 480);
        await act(async () => {
            fireEvent(video, new Event("resize"));
        });
        expect(drawnShape(video)).toBeCloseTo(4 / 3);
    });
});
