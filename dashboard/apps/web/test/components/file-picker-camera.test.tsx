// @vitest-environment jsdom

/**
 * The shared picker's camera: offered to every screen that takes pictures or
 * video, on a device that has a camera, and never to one that takes neither.
 */

import { MessagesWrapper } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { FilePickerDialog } from "@/components/file-picker/file-picker-dialog";
import { cameraAvailable, cameraKinds } from "@/components/file-picker/camera-kinds";

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("cameraKinds", () => {
    it("offers a photo to a screen that takes pictures", () => {
        expect(cameraKinds("image/*")).toEqual({ photo: "image/jpeg", video: false });
        expect(cameraKinds("image/png,image/jpeg,image/webp,image/gif")).toEqual({
            photo: "image/jpeg",
            video: false
        });
        expect(cameraKinds("image/png")).toEqual({ photo: "image/png", video: false });
        expect(cameraKinds(".JPG, .png")).toEqual({ photo: "image/jpeg", video: false });
    });

    it("offers a video to a screen that takes video", () => {
        expect(cameraKinds("video/*")).toEqual({ photo: null, video: true });
        expect(cameraKinds("image/*,video/mp4")).toEqual({ photo: "image/jpeg", video: true });
        expect(cameraKinds(".webm")).toEqual({ photo: null, video: true });
    });

    it("offers both to a screen that takes anything", () => {
        expect(cameraKinds(undefined)).toEqual({ photo: "image/jpeg", video: true });
        expect(cameraKinds("")).toEqual({ photo: "image/jpeg", video: true });
    });

    it("offers nothing to a screen that takes neither, or only stored files", () => {
        for (const accept of [
            ".xlsx,.csv",
            "audio/*",
            ".md,.markdown,.mdx,.txt,.zip",
            ".polaris",
            "image/svg+xml",
            "image/gif"
        ]) {
            expect(cameraKinds(accept), accept).toEqual({ photo: null, video: false });
        }
        expect(cameraKinds("image/*", true)).toEqual({ photo: null, video: false });
    });
});

describe("cameraAvailable", () => {
    const coarse = (matches: boolean) => () => ({ matches });

    it("is there when the browser lists a camera, or on a phone", async () => {
        const listing = (kinds: string[]) => ({
            mediaDevices: { enumerateDevices: async () => kinds.map((kind) => ({ kind })) }
        });
        expect(
            await cameraAvailable({ navigator: listing(["videoinput"]), matchMedia: coarse(false) })
        ).toBe(true);
        expect(
            await cameraAvailable({ navigator: listing(["audioinput"]), matchMedia: coarse(false) })
        ).toBe(false);
        expect(await cameraAvailable({ navigator: {}, matchMedia: coarse(true) })).toBe(true);
        expect(await cameraAvailable({ navigator: {}, matchMedia: coarse(false) })).toBe(false);
        expect(
            await cameraAvailable({
                navigator: {
                    mediaDevices: {
                        enumerateDevices: async () => {
                            throw new Error("denied");
                        }
                    }
                },
                matchMedia: coarse(false)
            })
        ).toBe(false);
    });
});

function stub(hasCamera: boolean, phone = false): void {
    vi.stubGlobal(
        "fetch",
        vi.fn(
            async () =>
                new Response(JSON.stringify({ sources: [], entries: [] }), {
                    headers: { "content-type": "application/json" }
                })
        )
    );
    Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
            enumerateDevices: async () => (hasCamera ? [{ kind: "videoinput" }] : []),
            getUserMedia: async () => {
                throw new Error("no camera in tests");
            }
        }
    });
    vi.stubGlobal("matchMedia", () => ({ matches: phone }));
}

describe("the picker's Camera tab", () => {
    it("shows for a screen that takes pictures when a camera exists", async () => {
        stub(true);
        render(<FilePickerDialog accept="image/*" onPick={() => {}} onClose={() => {}} />, {
            wrapper: MessagesWrapper
        });
        await waitFor(() => expect(screen.getByRole("button", { name: "Camera" })).toBeTruthy());
    });

    it("stays hidden with no camera, or for a screen that takes neither", async () => {
        stub(false);
        render(<FilePickerDialog accept="image/*" onPick={() => {}} onClose={() => {}} />, {
            wrapper: MessagesWrapper
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(screen.queryByRole("button", { name: "Camera" })).toBeNull();
        cleanup();

        stub(true);
        render(<FilePickerDialog accept=".xlsx,.csv" onPick={() => {}} onClose={() => {}} />, {
            wrapper: MessagesWrapper
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(screen.queryByRole("button", { name: "Camera" })).toBeNull();
    });

    it("opens the phone's own camera and gallery with only what the screen takes", async () => {
        stub(false, true);
        render(<FilePickerDialog accept="image/*" onPick={() => {}} onClose={() => {}} />, {
            wrapper: MessagesWrapper
        });
        await userEvent.click(await screen.findByRole("button", { name: "Camera" }));
        expect(screen.getByRole("button", { name: "Take a photo" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Record a video" })).toBeNull();
        expect(screen.getByRole("button", { name: "Choose from gallery" })).toBeTruthy();
        const capture = document.querySelector("input[capture]");
        expect(capture?.getAttribute("accept")).toBe("image/*");
    });

    it("hands a photo taken on the phone back as an upload", async () => {
        stub(false, true);
        const onPick = vi.fn();
        render(<FilePickerDialog accept="image/*" onPick={onPick} onClose={() => {}} />, {
            wrapper: MessagesWrapper
        });
        await userEvent.click(await screen.findByRole("button", { name: "Camera" }));
        const photo = new File([new Uint8Array([1])], "photo.jpg", { type: "image/jpeg" });
        await userEvent.upload(document.querySelector("input[capture]") as HTMLInputElement, photo);
        expect(onPick).toHaveBeenCalledWith([{ kind: "upload", file: photo }]);
    });
});
