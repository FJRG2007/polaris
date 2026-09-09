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
    const body = await request.arrayBuffer();
    if (body.byteLength === 0)
        return NextResponse.json({ error: "No picture was sent." }, { status: 400 });
    if (body.byteLength > MOST_IMAGE_BYTES)
        return NextResponse.json({ error: "This picture is too large." }, { status: 413 });
    const bytes = new Uint8Array(body);

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
