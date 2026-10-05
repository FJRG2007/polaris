// @vitest-environment jsdom

/**
 * The real diagram editor, opened.
 *
 * Rendered with the canvas library itself rather than a stand-in, inside the
 * same export slot the document chrome gives it, for a new diagram and one with
 * shapes in it, under both themes. What it pins is that opening one settles: no
 * "Maximum update depth exceeded", no error at all.
 */

import * as Y from "yjs";
import { MessagesWrapper } from "../setup/i18n";
import { OfficeExportProvider } from "@/app/(app)/office/export-slot";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DiagramEditor } from "@/app/(app)/office/g/[id]/diagram-editor";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

vi.mock("@polaris/diagrams/styles.css", () => ({}));

// Next's loader waits on its own preload machinery, which never runs outside
// Next; React's own lazy loading is the same thing without it.
vi.mock("next/dynamic", async () => {
    const react = await import("react");
    return {
        default: (load: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
            const Lazy = react.lazy(async () => ({ default: await load() }));
            return function Loaded(props: Record<string, unknown>) {
                return react.createElement(
                    react.Suspense,
                    { fallback: null },
                    react.createElement(Lazy, props)
                );
            };
        }
    };
});

beforeAll(() => {
    class Quiet {
        onmessage: ((event: MessageEvent) => void) | null = null;
        close(): void {}
        addEventListener(): void {}
        removeEventListener(): void {}
    }
    vi.stubGlobal("EventSource", Quiet);
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status: 204 }))
    );
    if (!window.matchMedia) {
        window.matchMedia = ((query: string) => ({
            matches: false,
            media: query,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            addListener: () => undefined,
            removeListener: () => undefined,
            onchange: null,
            dispatchEvent: () => false
        })) as unknown as typeof window.matchMedia;
    }
    if (!window.ResizeObserver) {
        window.ResizeObserver = class {
            observe(): void {}
            unobserve(): void {}
            disconnect(): void {}
        } as unknown as typeof ResizeObserver;
    }
    // jsdom has no 2D canvas. Every drawing call is answered with nothing, and
    // every measurement with zero, which is all mounting the editor needs.
    const inert: ProxyHandler<object> = {
        get: (_target, key) =>
            key === "measureText"
                ? () => ({ width: 0, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0 })
                : key === "getImageData" || key === "createImageData"
                  ? () => ({ data: new Uint8ClampedArray(4) })
                  : key === "canvas"
                    ? document.createElement("canvas")
                    : () => undefined,
        set: () => true
    };
    HTMLCanvasElement.prototype.getContext = (() =>
        new Proxy({}, inert)) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    if (!("Path2D" in window)) {
        vi.stubGlobal(
            "Path2D",
            class {
                addPath(): void {}
            }
        );
    }
    if (!document.fonts) {
        Object.defineProperty(document, "fonts", {
            value: {
                has: () => true,
                add: () => undefined,
                check: () => true,
                load: async () => [],
                ready: Promise.resolve(),
                addEventListener: () => undefined,
                removeEventListener: () => undefined
            }
        });
    }
    if (!window.FontFace) {
        window.FontFace = class {
            load = async () => this;
        } as unknown as typeof FontFace;
    }
});

afterEach(() => {
    cleanup();
    document.documentElement.className = "";
});

/** A stored diagram with one rectangle in it. */
function drawn(): number[] {
    const doc = new Y.Doc();
    doc.getMap("shapes").set("r1", {
        id: "r1",
        type: "rectangle",
        x: 10,
        y: 10,
        width: 100,
        height: 60,
        version: 1,
        versionNonce: 1,
        isDeleted: false,
        updated: 1
    });
    return Array.from(Y.encodeStateAsUpdate(doc));
}

describe.each([
    ["dark", ""],
    ["light", "light"]
])("a diagram opened on the %s theme", (_name, rootClass) => {
    it.each([
        ["new", null],
        ["existing", drawn()]
    ])("opens a %s one without an update loop", async (_kind, content) => {
        document.documentElement.className = rootClass;
        const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const { container } = render(
            <OfficeExportProvider>
                <div style={{ height: 600 }}>
                    <DiagramEditor documentId="d1" content={content} editable />
                </div>
            </OfficeExportProvider>,
            { wrapper: MessagesWrapper }
        );
        // The canvas really mounted - otherwise this proves nothing - and then
        // long enough for it to run its first rounds of effects.
        await waitFor(
            () => {
                if (!container.querySelector(".polaris-diagram"))
                    throw new Error("not mounted yet");
            },
            { timeout: 25_000 }
        );
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 1000));
        });
        const loops = errors.mock.calls.filter((call) =>
            String(call[0]).includes("Maximum update depth")
        );
        expect(loops).toEqual([]);
        // The canvas really mounted - otherwise this proves nothing.
        expect(container.querySelector(".polaris-diagram")).not.toBeNull();
        errors.mockRestore();
    });
});

describe("the diagram canvas's toolbar", () => {
    it("offers no web-embed tool, since Office renders no embeds for it", async () => {
        const { container } = render(
            <OfficeExportProvider>
                <div style={{ height: 600 }}>
                    <DiagramEditor documentId="d1" content={null} editable />
                </div>
            </OfficeExportProvider>,
            { wrapper: MessagesWrapper }
        );
        await waitFor(
            () => {
                if (!container.querySelector(".polaris-diagram"))
                    throw new Error("not mounted yet");
            },
            { timeout: 25_000 }
        );
        const trigger = container.querySelector<HTMLButtonElement>(
            ".App-toolbar__extra-tools-trigger"
        );
        expect(trigger).not.toBeNull();
        await act(async () => {
            fireEvent.click(trigger!);
        });
        // The frame and laser tools still open; the web-embed tool - which
        // Office never gives a renderer, since it would point the canvas at a
        // third party - is not offered at all.
        expect(container.querySelector('[data-testid="toolbar-frame"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="toolbar-laser"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="toolbar-embeddable"]')).toBeNull();
    });
});
