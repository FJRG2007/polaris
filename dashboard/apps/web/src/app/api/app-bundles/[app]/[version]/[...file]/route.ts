/**
 * The browser half of an installed app's bundle, and the files it ships.
 *
 * Served from the bundle unpacked on the data volume. The address carries the
 * bundle's digest, so a file never changes under it and is cached for good.
 * `current` in its place is the bundle loaded now, for an address an app writes
 * into its own code (its icons, say), which cannot know its own digest; that one
 * is cached for an hour, since an update may change what it names - except a
 * file whose name carries its own content hash (`name-<16 hex>.ext`), which is
 * cached for good under either, and a page, which is checked again every time
 * so it never names files an update removed. The server half is never served:
 * it is the app's server code.
 *
 * A page (an app's game, say) runs same-origin in a frame, so it gets a
 * content policy that keeps it to files from here.
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { mimeForName } from "@/lib/mime";
import { loadedBundle } from "@/lib/app-bundles/loader";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PART = /^[A-Za-z0-9._@()[\]-]+$/;

const FOREVER = "public, max-age=31536000, immutable";
const AN_HOUR = "public, max-age=3600";
const HASHED = /-[0-9a-f]{16}\.[a-z0-9]+$/;

/** What a bundle ships besides scripts and what `mimeForName` knows. */
const TYPES: Record<string, string> = {
    js: "text/javascript; charset=utf-8",
    html: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    woff2: "font/woff2",
    bin: "application/octet-stream"
};

const PAGE_POLICY = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'"
].join("; ");

export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ app: string; version: string; file: string[] }> }
) {
    const { app, version, file } = await params;
    const bundle = loadedBundle(app);
    const [area] = file;
    // The build an update just replaced is still served to the pages opened
    // before it, so they keep working until they are reloaded.
    const dir =
        version === bundle?.previous?.version ? bundle.previous.dir : bundle?.dir;
    if (
        !bundle ||
        !dir ||
        (version !== bundle.version && version !== "current" && version !== bundle.previous?.version) ||
        (area !== "client" && area !== "assets") ||
        file.some((part) => !PART.test(part) || part === "." || part === "..")
    ) {
        return new Response("Not found", { status: 404 });
    }
    const name = file[file.length - 1] as string;
    try {
        const bytes = await readFile(join(dir, ...file));
        const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
        const type = TYPES[ext] ?? mimeForName(name) ?? "application/octet-stream";
        const page = ext === "html";
        const headers: Record<string, string> = {
            "content-type": type,
            "cache-control": page
                ? "no-cache"
                : version !== "current" || HASHED.test(name)
                  ? FOREVER
                  : AN_HOUR,
            "x-content-type-options": "nosniff"
        };
        if (page) headers["content-security-policy"] = PAGE_POLICY;
        return new Response(new Uint8Array(bytes), { headers });
    } catch {
        return new Response("Not found", { status: 404 });
    }
}
