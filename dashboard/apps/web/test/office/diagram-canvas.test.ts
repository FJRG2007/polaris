// @vitest-environment jsdom

/**
 * The diagram canvas Polaris keeps in `packages/diagrams`, held to three
 * promises.
 *
 * - **It reaches no other server.** Every asset it asks for is under this
 *   origin's `/diagram-assets/`, and the built code names no host it would
 *   fetch from. The upstream editor loaded its fonts from a public CDN, which is
 *   a request to somebody else's server every time a diagram opens.
 * - **A diagram saved before still opens unchanged.** Shapes are stored as the
 *   upstream editor wrote them; restoring one keeps every field the merge and
 *   the drawing read.
 * - **Export still produces a picture**, as SVG and PNG.
 */

import * as Y from "yjs";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { base, packageRoot } from "../../scripts/copy-diagram-assets.mjs";

/** Loaded once the page has a canvas to probe: the editor checks what the 2D
 *  context supports as it loads. */
let canvas: typeof import("@polaris/diagrams");

const dist = join(packageRoot, "dist");

/** Every built file of a kind, read as text. */
function built(extension: string): string[] {
    const found: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (entry.name.endsWith(extension)) found.push(readFileSync(path, "utf8"));
        }
    };
    walk(dist);
    return found;
}

/**
 * Hosts the built code may name without ever being sent a request: XML
 * namespaces, which are identifiers, and the sites a person can paste an
 * embed link from - those load only when somebody puts one on a canvas, and
 * only in the frame they asked for.
 */
const NAMED_NOT_FETCHED = new Set([
    "www.w3.org",
    "www.youtube.com",
    "player.vimeo.com",
    "www.figma.com",
    "gist.github.com",
    "twitter.com",
    "platform.twitter.com",
    "reddit.com",
    "embed.reddit.com",
    "giphy.com"
]);

/** A rectangle and a line of text, stored the way the upstream editor stored
 *  them - every field, including the ones Polaris's merge never reads. */
function saved() {
    return [
        {
            id: "r1",
            type: "rectangle",
            x: 10,
            y: 20,
            width: 120,
            height: 60,
            angle: 0,
            strokeColor: "#1e1e1e",
            backgroundColor: "#a5d8ff",
            fillStyle: "solid",
            strokeWidth: 2,
            strokeStyle: "solid",
            roughness: 1,
            opacity: 100,
            groupIds: [],
            frameId: null,
            index: "a0",
            roundness: { type: 3 },
            seed: 1234,
            version: 7,
            versionNonce: 42,
            isDeleted: false,
            boundElements: [{ type: "text", id: "t1" }],
            updated: 1700000000000,
            link: null,
            locked: false
        },
        {
            id: "t1",
            type: "text",
            x: 20,
            y: 37,
            width: 100,
            height: 25,
            angle: 0,
            strokeColor: "#1e1e1e",
            backgroundColor: "transparent",
            fillStyle: "solid",
            strokeWidth: 2,
            strokeStyle: "solid",
            roughness: 1,
            opacity: 100,
            groupIds: [],
            frameId: null,
            index: "a1",
            roundness: null,
            seed: 99,
            version: 3,
            versionNonce: 7,
            isDeleted: false,
            boundElements: null,
            updated: 1700000000000,
            link: null,
            locked: false,
            text: "Hello",
            fontSize: 20,
            // 5 is the hand-drawn face every new diagram starts in.
            fontFamily: 5,
            textAlign: "center",
            verticalAlign: "middle",
            containerId: "r1",
            originalText: "Hello",
            autoResize: true,
            lineHeight: 1.25
        }
    ];
}

/** What a saved shape has to come back with: everything stored, as stored. */
const KEPT = [
    "id",
    "type",
    "x",
    "y",
    "width",
    "height",
    "strokeColor",
    "backgroundColor",
    "fillStyle",
    "roughness",
    "roundness",
    "seed",
    "version",
    "versionNonce",
    "isDeleted",
    "index",
    "boundElements",
    "text",
    "fontSize",
    "fontFamily",
    "containerId"
] as const;

const fetched: string[] = [];

beforeAll(async () => {
    // jsdom draws nothing; the exporters only need the calls to exist.
    const inert: ProxyHandler<object> = {
        get: (_target, key) =>
            key === "measureText"
                ? () => ({ width: 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 })
                : key === "getImageData" || key === "createImageData"
                  ? () => ({ data: new Uint8ClampedArray(4) })
                  : () => undefined,
        set: () => true
    };
    HTMLCanvasElement.prototype.getContext = (() =>
        new Proxy({}, inert)) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback, type?: string) {
        callback(new Blob([new Uint8Array([137, 80, 78, 71])], { type: type ?? "image/png" }));
    };
    if (!("Path2D" in window)) vi.stubGlobal("Path2D", class {});
    // Enough of a font face for the exporter to decide which files to read.
    window.FontFace = class {
        family: string;
        unicodeRange: string;
        constructor(family: string, _source: string, descriptors?: FontFaceDescriptors) {
            this.family = family;
            this.unicodeRange = descriptors?.unicodeRange ?? "U+0-10FFFF";
        }
        load = async () => this;
    } as unknown as typeof FontFace;
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
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
            fetched.push(String(input instanceof Request ? input.url : input));
            return new Response(new ArrayBuffer(0), { status: 404 });
        })
    );
    canvas = await import("@polaris/diagrams");
});

afterEach(() => {
    fetched.length = 0;
});

describe("the diagram canvas's assets", () => {
    it("are asked for under the path the build stages them at", () => {
        expect(base).toBe("/diagram-assets");
        const code = built(".js").join("\n");
        expect(code).toContain(`"${base}/"`);
    });

    it("are built: fonts under dist/editor/fonts, and the licence beside them", () => {
        const fonts = readdirSync(join(dist, "editor", "fonts"));
        expect(fonts).toEqual(expect.arrayContaining(["Handwritten", "Virgil", "Cascadia"]));
        expect(readFileSync(join(packageRoot, "LICENSE"), "utf8")).toMatch(/MIT License/);
    });

    it("name no host the canvas would fetch from", () => {
        const hosts = new Set<string>();
        for (const text of [...built(".js"), ...built(".css")]) {
            for (const match of text.matchAll(/https?:\/\/([a-z0-9.*-]+\.[a-z]{2,})/gi)) {
                hosts.add(match[1]!.toLowerCase());
            }
        }
        expect([...hosts].filter((host) => !NAMED_NOT_FETCHED.has(host))).toEqual([]);
    });

    it("never asks where its own file is", () => {
        // A host bundler rewrites a bare `import.meta.url` to the path the module
        // was built from: a worker that cannot start, and the build machine's
        // directory layout in every client bundle.
        expect(built(".js").join("\n")).not.toContain("import.meta.url");
    });

    it("style only classes the canvas actually puts on its elements", () => {
        // The canvas's own class names were renamed on the way in; a selector
        // renamed one way and the markup another is a canvas whose layers stack
        // in the wrong order and swallow every press.
        let code = "";
        const walk = (dir: string): void => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const path = join(dir, entry.name);
                if (entry.isDirectory()) walk(path);
                else if (/\.tsx?$/.test(entry.name)) code += readFileSync(path, "utf8");
            }
        };
        walk(join(packageRoot, "src"));
        const styled = new Set(
            [...built(".css").join("\n").matchAll(/\.((?:polaris-)?diagram[\w-]*)/g)].map((m) => m[1]!)
        );
        expect([...styled].filter((name) => !code.includes(name))).toEqual([]);
    });

    it("say nothing of where the code came from in the stylesheet's class names", () => {
        const css = built(".css").join("\n");
        expect(css).not.toMatch(/\.excalidraw/i);
        expect(css).toContain(".polaris-diagram");
    });
});

describe("a diagram saved before", () => {
    it("comes back with every field it was stored with", () => {
        const stored = saved();
        const restored = canvas.restoreElements(stored as never, null);
        expect(restored).toHaveLength(stored.length);
        for (const [index, element] of restored.entries()) {
            const original = stored[index] as Record<string, unknown>;
            for (const key of KEPT) {
                if (!(key in original)) continue;
                // An empty list of bindings is stored as null by older saves and
                // read back as an empty list, as the upstream editor always did.
                const expected = key === "boundElements" ? (original[key] ?? []) : original[key];
                expect((element as unknown as Record<string, unknown>)[key], `${original.id}.${key}`).toEqual(
                    expected
                );
            }
        }
    });

    it("survives the trip through the shared document unchanged", () => {
        const doc = new Y.Doc();
        const shapes = doc.getMap<unknown>("shapes");
        for (const element of saved()) shapes.set(element.id, element);
        const copy = new Y.Doc();
        Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
        const back = [...copy.getMap<unknown>("shapes").values()];
        expect(back).toEqual(saved());
        const restored = canvas.restoreElements(back as never, null);
        expect(restored.map((element) => [element.id, element.version, element.versionNonce])).toEqual([
            ["r1", 7, 42],
            ["t1", 3, 7]
        ]);
    });
});

describe("exporting a diagram", () => {
    const appState = { exportBackground: true, viewBackgroundColor: "#ffffff" };

    it("draws it as an SVG the size of what is on it", async () => {
        const svg = await canvas.exportToSvg({
            elements: canvas.restoreElements(saved() as never, null),
            appState: appState as never,
            files: null
        });
        expect(svg.tagName.toLowerCase()).toBe("svg");
        expect(Number(svg.getAttribute("width"))).toBeGreaterThan(100);
        expect(svg.querySelectorAll("path, rect, text").length).toBeGreaterThan(0);
        expect(svg.outerHTML).toContain("Hello");
        // The text's face is inlined into the file, read from this origin under
        // the staged path - never from a CDN, and never from a path the build
        // does not stage (a chunk-relative "../editor/..." once escaped it).
        expect(fetched.length).toBeGreaterThan(0);
        for (const url of fetched) {
            const { origin, pathname } = new URL(url);
            expect(origin).toBe(window.location.origin);
            expect(pathname.startsWith(`${base}/editor/fonts/`), pathname).toBe(true);
            const staged = join(dist, ...pathname.slice(base.length + 1).split("/"));
            expect(() => readFileSync(staged), staged).not.toThrow();
        }
    });

    it("draws it as a PNG", async () => {
        const blob = await canvas.exportToBlob({
            elements: canvas.restoreElements(saved() as never, null),
            appState: appState as never,
            files: null,
            mimeType: "image/png"
        });
        expect(blob.type).toBe("image/png");
        expect(blob.size).toBeGreaterThan(0);
    });
});
