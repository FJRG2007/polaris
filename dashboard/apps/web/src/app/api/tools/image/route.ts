/**
 * The picture half of Tools, done on this machine.
 *
 * Two questions on one route, because they are asked about the same upload and
 * splitting them would mean sending the file twice: `?op=facts` answers what the
 * picture is, and anything else re-encodes it and hands the bytes back.
 *
 * Nothing is stored. The bytes arrive, are decoded and encoded, and go back in
 * the response - there is no file on disk at any point and nothing is written to
 * the database. That is the whole reason for doing this here instead of on one
 * of the websites that offer it: the picture never leaves the machine its owner
 * already trusts.
 */

import { NextResponse } from "next/server";
import { sessionCan } from "@/lib/session";
import { apiUser } from "@/lib/api-session";
import { toolsInstall } from "@/lib/tools/access";
import {
    IMAGE_TYPES,
    MOST_IMAGE_BYTES,
    isImageFormat,
    readImageFacts,
    transformImage
} from "@/lib/tools/images";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    if (!(await sessionCan(user, "tools.use")))
        return NextResponse.json({ error: "Not allowed." }, { status: 403 });
    // The app can be removed, and removing it has to actually turn its routes
    // off - otherwise "uninstalled" means "hidden", which is not the promise the
    // marketplace makes.
    if (!(await toolsInstall()))
        return NextResponse.json({ error: "Tools is not installed." }, { status: 404 });

    const url = new URL(request.url);
    const bytes = await readUpload(request);
    if (bytes === "too-large")
        return NextResponse.json({ error: "This picture is too large." }, { status: 413 });
    if (bytes.byteLength === 0)
        return NextResponse.json({ error: "No picture was sent." }, { status: 400 });

    if (url.searchParams.get("op") === "facts") {
        try {
            return NextResponse.json(await readImageFacts(bytes));
        } catch {
            return NextResponse.json({ error: "That file is not a picture." }, { status: 422 });
        }
    }

    const format = url.searchParams.get("format") ?? "";
    if (!isImageFormat(format))
        return NextResponse.json({ error: "Unknown format." }, { status: 400 });

    const longest = Number(url.searchParams.get("max"));
    try {
        const result = await transformImage(bytes, {
            format,
            quality: Number(url.searchParams.get("q")) || 80,
            longestSide: Number.isFinite(longest) && longest > 0 ? Math.round(longest) : null,
            keepMetadata: url.searchParams.get("meta") === "1"
        });
        return new Response(result.bytes as BodyInit, {
            headers: {
                "Content-Type": IMAGE_TYPES[format].mime,
                "Content-Length": String(result.bytes.byteLength),
                // The screen draws the result and says how big it came out; both
                // are read from here rather than measured again in the browser.
                "X-Image-Width": String(result.width),
                "X-Image-Height": String(result.height),
                "Cache-Control": "no-store"
            }
        });
    } catch {
        return NextResponse.json({ error: "That picture could not be read." }, { status: 422 });
    }
}

/**
 * The upload, or `too-large` before it has all arrived.
 *
 * Read off the stream with a running total rather than through
 * `arrayBuffer()`, because that buffers the whole thing first: a limit checked
 * after the allocation is a limit that never prevents the allocation it exists
 * for, and a handful of large POSTs from anyone holding `tools.use` would be
 * the container's heap. The declared length is trusted only to refuse early -
 * it can be absent or a lie, so the count over the bytes actually read is what
 * decides.
 */
async function readUpload(request: Request): Promise<Uint8Array | "too-large"> {
    if (Number(request.headers.get("content-length") ?? "0") > MOST_IMAGE_BYTES) return "too-large";
    const stream = request.body;
    if (!stream) return new Uint8Array(0);

    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            total += value.byteLength;
            if (total > MOST_IMAGE_BYTES) {
                await reader.cancel().catch(() => undefined);
                return "too-large";
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.byteLength;
    }
    return bytes;
}
