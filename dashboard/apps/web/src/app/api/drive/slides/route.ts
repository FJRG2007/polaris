/**
 * Turning an uploaded .pptx into pages a browser can draw.
 *
 * The parser needs Node - it unzips the package and hashes parts, and two of the
 * modules under it import `node:zlib` and `node:crypto` - so it cannot run in
 * the tab. The tab sends the bytes it already has and is handed back plain data
 * describing what to draw.
 *
 * **The bytes come in the request rather than being read from Drive here**, and
 * that is deliberate. The reader has already been authorised for this file: the
 * browser fetched it through Drive's own byte route, or through a share token's,
 * and either way that check has happened. Reading it again from a path in a
 * query string would be a second way into somebody's files, with its own access
 * check to keep in step with the first - and it would not work at all for a
 * public share, which has no connection to name. What this receives is bytes
 * somebody already holds, and it hands back a rendering of them.
 *
 * So nothing is stored, nothing is looked up, and the answer depends on nothing
 * but the request. It is still not open to the internet, because parsing a
 * presentation is real work on somebody's machine: either a signed-in reader
 * asks, or a share token does - and a token goes through the same gate the
 * download path uses, expiry, address rules and all. A presentation is viewable
 * on a public share, so requiring a session here would have broken every one of
 * them.
 */

import { NextResponse } from "next/server";
import { guardedUser } from "@/lib/session";
import { gateShareRequest } from "@/lib/share-access";
import { renderPptxDeck, DEFAULT_DECK_WIDTH } from "@/lib/office/pptx-deck";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** As much presentation as anybody opens in a viewer. A .pptx larger than this
 *  is refused rather than parsed, because the parse is the expensive part and it
 *  happens before anything can decide the file was unreasonable. */
const MOST_BYTES = 80 * 1024 * 1024;

/** The widths a deck may be built for. Free-form numbers would let one request
 *  ask for a deck the size of a wall, and every distinct width is a full rebuild
 *  of every page. */
const WIDTHS = [640, 960, 1280, 1600, 1920];

export async function POST(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const token = url.searchParams.get("t");
    if (token) {
        const gate = await gateShareRequest(token, "slides.render");
        if (!gate.ok) return NextResponse.json({ error: "Not available." }, { status: gate.status });
    } else if (!(await guardedUser())) {
        return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }

    const asked = Number(url.searchParams.get("w"));
    const width = WIDTHS.includes(asked) ? asked : DEFAULT_DECK_WIDTH;

    const body = await request.arrayBuffer();
    if (body.byteLength === 0)
        return NextResponse.json({ error: "No presentation was sent." }, { status: 400 });
    if (body.byteLength > MOST_BYTES)
        return NextResponse.json({ error: "This presentation is too large." }, { status: 413 });

    try {
        const deck = await renderPptxDeck(new Uint8Array(body), width);
        return NextResponse.json({ slides: deck.slides });
    } catch {
        // What went wrong is a detail of a file format, and naming it tells a
        // reader nothing they can act on. The screen says the presentation could
        // not be read.
        return NextResponse.json({ error: "This presentation could not be read." }, { status: 422 });
    }
}
