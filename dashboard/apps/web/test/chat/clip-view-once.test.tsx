// @vitest-environment jsdom

/**
 * A recorded clip can be sent to be seen once: the timer chosen in the clip
 * dialog is handed over with the file, and nothing is when it is not offered.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const clipFile = new File([new Uint8Array([1, 2, 3])], "clip.webm", { type: "video/webm" });

vi.mock("@/app/(app)/chat/clip-recorder", () => ({
    MAX_CLIP_SECONDS: 600,
    useClipRecorder: () => ({
        stage: "ready",
        file: clipFile,
        url: null,
        seconds: 4,
        error: null,
        canvas: null,
        camera: null,
        start: () => undefined,
        pause: () => undefined,
        resume: () => undefined,
        stop: () => undefined,
        discard: () => undefined
    })
}));
vi.mock("@/app/(app)/chat/call-media", () => ({
    callDevices: async () => ({ microphones: [], cameras: [] })
}));
vi.mock("@/app/(app)/chat/mic-device", () => ({ micDevice: () => undefined }));
vi.mock("@/app/(app)/chat/mic-settings", () => ({ MicSettings: () => null }));
vi.mock("@/components/media-player", () => ({ MediaPlayer: () => null }));

const { ClipDialog } = await import("@/app/(app)/chat/clip-dialog");

afterEach(cleanup);

function open(canViewOnce: boolean) {
    const onReady = vi.fn();
    render(
        <ClipDialog
            open
            onOpenChange={() => undefined}
            onReady={onReady}
            canViewOnce={canViewOnce}
            maxBytes={1024 * 1024}
            maxMib={1}
        />
    );
    return onReady;
}

describe("a recorded clip", () => {
    it("carries the view-once timer chosen for it", async () => {
        const onReady = open(true);
        const trigger = screen.getByRole("button", { name: /viewOnce\.label/ });
        fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
        const [ten] = await screen.findAllByRole("menuitem", { name: /viewOnce\.seconds/ });
        // The first timer offered is the shortest; any one will do.
        fireEvent.click(ten!);
        fireEvent.click(screen.getByRole("button", { name: /clip\.attachIt/ }));
        expect(onReady).toHaveBeenCalledTimes(1);
        const [file, seconds] = onReady.mock.calls[0]!;
        expect(file).toBe(clipFile);
        expect(typeof seconds).toBe("number");
    });

    it("goes as an ordinary file when view once was not chosen", () => {
        const onReady = open(true);
        fireEvent.click(screen.getByRole("button", { name: /clip\.attachIt/ }));
        expect(onReady).toHaveBeenCalledWith(clipFile, undefined);
    });

    it("offers no view once where the conversation takes none", () => {
        const onReady = open(false);
        expect(screen.queryByRole("button", { name: /viewOnce\.label/ })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: /clip\.attachIt/ }));
        expect(onReady).toHaveBeenCalledWith(clipFile, undefined);
    });
});
