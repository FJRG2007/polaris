/**
 * What is waiting, on the app's icon: what the page may hand over, and what
 * each system is told.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const app = { dock: { setBadge: vi.fn() }, setBadgeCount: vi.fn() };
const image = { isEmpty: () => false };
vi.mock("electron", () => ({ app, nativeImage: { createFromDataURL: vi.fn(() => image) } }));

const { appBadgeSchema, applyAppBadge } = await import("../../src/main/app-badge");

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const platform = process.platform;

function on(name: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", { value: name });
}

function windowStub() {
    return { isDestroyed: () => false, setOverlayIcon: vi.fn() };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => on(platform));

describe("appBadgeSchema", () => {
    it("takes a count with its picture", () => {
        expect(appBadgeSchema.safeParse({ label: "3", dot: false, count: 3, overlay: PNG }).success).toBe(true);
    });

    it("refuses a picture that is not a PNG drawn by the page", () => {
        const remote = { label: "3", dot: false, count: 3, overlay: "https://example.com/x.png" };
        expect(appBadgeSchema.safeParse(remote).success).toBe(false);
        const svg = { label: "3", dot: false, count: 3, overlay: "data:image/svg+xml;base64,PHN2Zz4=" };
        expect(appBadgeSchema.safeParse(svg).success).toBe(false);
    });

    it("refuses a long label and anything it does not expect", () => {
        expect(appBadgeSchema.safeParse({ label: "12345", dot: false, count: 1, overlay: null }).success).toBe(false);
        expect(appBadgeSchema.safeParse({ label: null, dot: false, count: 0, overlay: null, extra: 1 }).success).toBe(
            false
        );
    });
});

describe("applyAppBadge", () => {
    it("puts the picture on the taskbar button on Windows, and takes it off at zero", () => {
        on("win32");
        const window = windowStub();
        applyAppBadge(window as never, { label: "9+", dot: false, count: 12, overlay: PNG });
        expect(window.setOverlayIcon).toHaveBeenCalledWith(image, "9+");
        applyAppBadge(window as never, { label: null, dot: false, count: 0, overlay: null });
        expect(window.setOverlayIcon).toHaveBeenLastCalledWith(null, "");
    });

    it("writes the label on the Dock, and a bullet for a dot", () => {
        on("darwin");
        applyAppBadge(null, { label: "4", dot: false, count: 4, overlay: null });
        expect(app.dock.setBadge).toHaveBeenLastCalledWith("4");
        applyAppBadge(null, { label: null, dot: true, count: 4, overlay: null });
        expect(app.dock.setBadge).toHaveBeenLastCalledWith("•");
        applyAppBadge(null, { label: null, dot: false, count: 0, overlay: null });
        expect(app.dock.setBadge).toHaveBeenLastCalledWith("");
    });

    it("gives Linux the number, and nothing for a dot it cannot draw", () => {
        on("linux");
        applyAppBadge(null, { label: "4", dot: false, count: 4, overlay: null });
        expect(app.setBadgeCount).toHaveBeenLastCalledWith(4);
        applyAppBadge(null, { label: null, dot: true, count: 4, overlay: null });
        expect(app.setBadgeCount).toHaveBeenLastCalledWith(0);
    });
});
