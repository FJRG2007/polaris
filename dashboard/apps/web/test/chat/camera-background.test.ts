/**
 * What a browser remembers about the background behind its camera.
 *
 * Local storage is editable by whoever owns the browser and survives every
 * version of Polaris that ever wrote to it, so nothing read back out of it is
 * believed. The case worth the test is the one that is not obviously a setting
 * at all: `image` with no picture behind it, which is what is left after somebody
 * clears their site data, and which would otherwise be a camera compositing
 * itself against nothing.
 */

import { describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

vi.stubGlobal("window", {
    localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key)
    },
    dispatchEvent: () => true
});

const { backgroundImage, cameraBackground, rememberBackgroundImage, setCameraBackground } =
    await import("@/app/(app)/chat/camera-background");

const KEY = "polaris.call.camera-background";
const IMAGE_KEY = "polaris.call.camera-background-image";

/** A one-pixel JPEG, which is only ever handled here as an opaque string. */
const PICTURE = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

describe("the background a browser remembers", () => {
    it("is off until somebody says otherwise", () => {
        store.clear();
        expect(cameraBackground()).toBe("off");
    });

    it("takes nothing it did not write itself", () => {
        store.clear();
        store.set(KEY, "beach");
        expect(cameraBackground()).toBe("off");
    });

    it("is off rather than a picture that is no longer there", () => {
        store.clear();
        store.set(KEY, "image");
        // Site data cleared, or a quota that refused the picture and kept the
        // setting. Either way there is nothing to draw.
        expect(cameraBackground()).toBe("off");
    });

    it("is the picture once there is one", () => {
        store.clear();
        store.set(KEY, "image");
        store.set(IMAGE_KEY, PICTURE);
        expect(cameraBackground()).toBe("image");
        expect(backgroundImage()).toBe(PICTURE);
    });

    it("stores nothing for the default", () => {
        store.clear();
        setCameraBackground("strong");
        expect(store.get(KEY)).toBe("strong");
        setCameraBackground("off");
        expect(store.has(KEY)).toBe(false);
    });
});

describe("a file somebody picks", () => {
    it("has to be a picture, whatever it is called", async () => {
        const file = new File(["not a picture"], "holiday.jpg", { type: "text/plain" });
        await expect(rememberBackgroundImage(file)).rejects.toThrow(/not a picture/i);
    });

    it("has to be small enough to decode", async () => {
        const huge = new File([new Uint8Array(1)], "raw.png", { type: "image/png" });
        // Size is the file's own claim about itself, which is what is checked -
        // the point is that it is checked before anything is decoded.
        Object.defineProperty(huge, "size", { value: 40 * 1024 * 1024 });
        await expect(rememberBackgroundImage(huge)).rejects.toThrow(/too large/i);
    });
});
