/**
 * The mark an MCP client draws beside Polaris: `serverInfo.icons` as MCP
 * 2025-11-25 defines it, checked against the SDK's own schema, on the origin the
 * client connected to and pointing at files this instance really serves. And
 * the root icons a client looks up by domain - /favicon.ico and
 * /apple-touch-icon.png - exist and are the images they claim to be.
 */

import { describe, expect, it } from "vitest";
import manifest from "../../src/app/manifest";
import { readFileSync } from "node:fs";
import { MARK_BACKGROUND, MARK_STAR } from "@/lib/favicon";
import { SERVER_ICON_FILES, serverIcons } from "@/lib/mcp/server-icons";
import { ImplementationSchema } from "@modelcontextprotocol/sdk/types.js";

const PUBLIC = new URL("../../public/", import.meta.url);
const APP = new URL("../../src/app/", import.meta.url);

/** Where a root path is served from: app/icon.svg by Next's file convention,
 *  everything else from public/. */
function fileFor(path: string): URL {
    return path === "/icon.svg" ? new URL("icon.svg", APP) : new URL(path.slice(1), PUBLIC);
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(bytes: Buffer): string {
    expect(bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
    return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

describe("serverInfo.icons", () => {
    it("points at this instance's own icons, on the origin the client used", () => {
        const icons = serverIcons("https://polaris.example.test");
        expect(icons).toEqual([
            {
                src: "https://polaris.example.test/icon.svg",
                mimeType: "image/svg+xml",
                sizes: ["any"]
            },
            {
                src: "https://polaris.example.test/polaris-mark-192.png",
                mimeType: "image/png",
                sizes: ["192x192"]
            },
            {
                src: "https://polaris.example.test/polaris-mark-512.png",
                mimeType: "image/png",
                sizes: ["512x512"]
            }
        ]);
        for (const icon of icons)
            expect(new URL(icon.src).origin).toBe("https://polaris.example.test");
    });

    it("is a valid Implementation by the SDK's schema", () => {
        for (const origin of ["https://polaris.example.test", "http://192.0.2.10:3000"])
            expect(
                ImplementationSchema.safeParse({
                    name: "polaris",
                    title: "Polaris",
                    version: "1",
                    icons: serverIcons(origin)
                }).success
            ).toBe(true);
    });

    it("carries the mark inline over plain HTTP, where a client refuses a URL", () => {
        const icons = serverIcons("http://192.0.2.10:3000");
        expect(icons).toHaveLength(1);
        const [icon] = icons;
        expect(icon.src.startsWith("data:image/svg+xml;base64,")).toBe(true);
        const svg = Buffer.from(icon.src.split(",")[1], "base64").toString("utf8");
        expect(svg).toContain(`fill="${MARK_BACKGROUND}"`);
        expect(svg).toContain(`d="${MARK_STAR}"`);
    });

    it("names files that exist, at the sizes they claim", () => {
        for (const file of SERVER_ICON_FILES) {
            const bytes = readFileSync(fileFor(file.path));
            if (file.mimeType === "image/png") expect([pngSize(bytes)]).toEqual(file.sizes);
            else expect(bytes.toString("utf8")).toContain(`d="${MARK_STAR}"`);
        }
    });

    it("are the icons the install manifest lists", () => {
        const listed = manifest().icons?.map((icon) => icon.src) ?? [];
        for (const file of SERVER_ICON_FILES) expect(listed).toContain(file.path);
    });
});

describe("the icons a client finds by domain", () => {
    it("serves a real ICO at /favicon.ico", () => {
        const bytes = readFileSync(new URL("favicon.ico", PUBLIC));
        // Reserved 0, type 1 (icon), then the image count.
        expect(bytes.readUInt16LE(0)).toBe(0);
        expect(bytes.readUInt16LE(2)).toBe(1);
        const count = bytes.readUInt16LE(4);
        const sizes: string[] = [];
        for (let index = 0; index < count; index++) {
            const entry = 6 + index * 16;
            const length = bytes.readUInt32LE(entry + 8);
            const offset = bytes.readUInt32LE(entry + 12);
            sizes.push(pngSize(bytes.subarray(offset, offset + length)));
        }
        expect(sizes).toEqual(["16x16", "32x32", "48x48"]);
    });

    it("serves a 180px /apple-touch-icon.png", () => {
        expect(pngSize(readFileSync(new URL("apple-touch-icon.png", PUBLIC)))).toBe("180x180");
    });
});
