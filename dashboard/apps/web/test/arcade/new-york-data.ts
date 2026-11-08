/**
 * Serves New York's shipped data to the engine under jsdom: the files the page names in its `<meta>` tags, read
 * from the source data, and a 2D canvas context that takes every call the texture painters make.
 */

import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { URL as FileUrl, fileURLToPath } from "node:url";
import { vi } from "vitest";

const data = fileURLToPath(new FileUrl("../../../arcade/game/new-york/data/", import.meta.url));

/** The files the page names in its `<meta>` tags, served from the source data. */
export function serveData() {
    const files: Record<string, () => Uint8Array> = {
        geo: () => gzipSync(readFileSync(`${data}geo.bin`)),
        buildings: () => readFileSync(`${data}buildings.bin.gz`),
        trees: () => readFileSync(`${data}trees.bin.gz`)
    };
    for (const name of Object.keys(files)) {
        const meta = document.createElement("meta");
        meta.name = name;
        meta.content = name;
        document.head.append(meta);
    }
    // Textures are painted on 2D canvases jsdom does not draw: a context that takes every call is all the build needs
    const pixels = (w: number, h: number) => ({
        width: w,
        height: h,
        data: new Uint8ClampedArray(w * h * 4)
    });
    const context: object = new Proxy(() => context, {
        get: (_target, key) => {
            if (key === "getImageData")
                return (_x: number, _y: number, w: number, h: number) => pixels(w, h);
            if (key === "createImageData") return (w: number, h: number) => pixels(w, h);
            if (key === "measureText") return () => ({ width: 10 });
            return context;
        },
        apply: () => context,
        set: () => true
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as never);
    vi.stubGlobal("fetch", async (name: string) => new Response(files[name]()));
}
