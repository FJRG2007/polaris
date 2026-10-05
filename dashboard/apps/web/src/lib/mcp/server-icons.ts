/**
 * The mark an MCP client shows next to this server.
 *
 * MCP 2025-11-25 (SEP-973) lets `serverInfo` carry `icons`, and its security
 * rules decide the shape here: a client accepts only an `https:` or `data:`
 * source, and checks that a URL is on the same origin as the server. So the
 * icons are this instance's own files on the origin the client connected to,
 * and an instance reached over plain HTTP - a LAN address - gets the mark
 * inline instead, as a URL there would be refused.
 *
 * The files are the ones the install manifest lists: the SVG for any size, and
 * PNG for the clients that only render the types the spec requires.
 */

import type { Icon } from "@modelcontextprotocol/sdk/types.js";
import { MARK_BACKGROUND, MARK_CORNER, MARK_FOREGROUND, MARK_SIZE, MARK_STAR } from "@/lib/favicon";

/** The icon files this instance serves at its root. */
export const SERVER_ICON_FILES = [
    { path: "/icon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
    { path: "/polaris-mark-192.png", mimeType: "image/png", sizes: ["192x192"] },
    { path: "/polaris-mark-512.png", mimeType: "image/png", sizes: ["512x512"] }
] as const;

/** The mark as an SVG document, from the same geometry as app/icon.svg. */
function markSvg(): string {
    const box = `width="${MARK_SIZE}" height="${MARK_SIZE}"`;
    return [
        `<svg xmlns="http://www.w3.org/2000/svg" ${box} viewBox="0 0 ${MARK_SIZE} ${MARK_SIZE}">`,
        `<rect ${box} rx="${MARK_CORNER}" fill="${MARK_BACKGROUND}"/>`,
        `<path d="${MARK_STAR}" fill="${MARK_FOREGROUND}"/></svg>`
    ].join("");
}

/** The `icons` of `serverInfo` for a client that reached this instance on
 *  `origin`. */
export function serverIcons(origin: string): Icon[] {
    const base = new URL(origin);
    if (base.protocol !== "https:")
        return [
            {
                src: `data:image/svg+xml;base64,${Buffer.from(markSvg()).toString("base64")}`,
                mimeType: "image/svg+xml",
                sizes: ["any"]
            }
        ];
    return SERVER_ICON_FILES.map((file) => ({
        src: new URL(file.path, base).toString(),
        mimeType: file.mimeType,
        sizes: [...file.sizes]
    }));
}
