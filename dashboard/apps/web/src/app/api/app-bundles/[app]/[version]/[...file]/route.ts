/**
 * The browser half of an installed app's bundle, and the files it ships.
 *
 * Served from the bundle unpacked on the data volume. The address carries the
 * bundle's digest, so a file never changes under it and is cached for good. The
 * server half is never served: it is the app's server code.
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { mimeForName } from "@/lib/mime";
import { loadedBundle } from "@/lib/app-bundles/loader";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PART = /^[A-Za-z0-9._@()[\]-]+$/;

export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ app: string; version: string; file: string[] }> }
) {
    const { app, version, file } = await params;
    const bundle = loadedBundle(app);
    const [area] = file;
    if (
        !bundle ||
        bundle.version !== version ||
        (area !== "client" && area !== "assets") ||
        file.some((part) => !PART.test(part) || part === "." || part === "..")
    ) {
        return new Response("Not found", { status: 404 });
    }
    const name = file[file.length - 1] as string;
    try {
        const bytes = await readFile(join(bundle.dir, ...file));
        const type = name.endsWith(".js")
            ? "text/javascript; charset=utf-8"
            : (mimeForName(name) ?? "application/octet-stream");
        return new Response(new Uint8Array(bytes), {
            headers: {
                "content-type": type,
                "cache-control": "public, max-age=31536000, immutable",
                "x-content-type-options": "nosniff"
            }
        });
    } catch {
        return new Response("Not found", { status: 404 });
    }
}
