// @vitest-environment jsdom

/**
 * The panel's edge starts a drag from the width the panel is drawn at.
 *
 * A panel nobody has resized follows the window, so its width is only known
 * once it is on screen. The handle has to start from that width, or the first
 * pixel of a drag snaps a wide panel down to the fallback.
 */

import { BlockPanel, type BlockStrings } from "../src/automation/blocks";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const strings = new Proxy({}, { get: (_, key) => String(key) }) as BlockStrings;

let drawn = 560;
let observed: (() => void) | null = null;
let kept = new Map<string, string>();

beforeEach(() => {
    drawn = 560;
    observed = null;
    kept = new Map();
    vi.stubGlobal("localStorage", {
        getItem: (key: string) => kept.get(key) ?? null,
        setItem: (key: string, value: string) => kept.set(key, value),
        removeItem: (key: string) => kept.delete(key)
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(() => drawn);
    vi.stubGlobal(
        "ResizeObserver",
        class {
            constructor(callback: () => void) {
                observed = callback;
            }
            observe() {}
            disconnect() {}
        }
    );
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

function panel() {
    return (
        <BlockPanel open title="Block" strings={strings} sizeKey="test.panel" onClose={() => {}}>
            fields
        </BlockPanel>
    );
}

describe("BlockPanel width", () => {
    it("starts from the width the panel is drawn at", () => {
        render(panel());
        expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("560");
    });

    it("follows the window when it changes the panel's width", () => {
        render(panel());
        drawn = 420;
        act(() => observed?.());
        expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("420");
    });

    it("prefers the width kept in this browser", () => {
        kept.set("test.panel", "500");
        render(panel());
        expect(screen.getByRole("separator").getAttribute("aria-valuenow")).toBe("500");
    });
});
