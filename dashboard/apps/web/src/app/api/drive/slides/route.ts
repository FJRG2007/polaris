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

/**
 * The body, read no further than `most` bytes, or `null` once it is past that.
 *
 * A route handler has no body limit of its own, so `arrayBuffer()` allocates
 * whatever arrives before anything can decide it was too much: a client sending
 * two gigabytes gets the allocation, and the refusal below it never runs. This
 * reads the stream instead and stops at the limit, so the most that is ever held
 * is the limit plus the chunk that crossed it.
 */
async function readCapped(request: Request, most: number): Promise<Uint8Array | null> {
    if (!request.body) return new Uint8Array(0);
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let held = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            held += value.byteLength;
            if (held > most) return null;
            chunks.push(value);
        }
    } finally {
        // Nothing more is wanted, whether the body ended or was refused. On a
        // refusal this is what stops the sender rather than reading the rest of
        // it into a buffer that is already being thrown away.
        void reader.cancel().catch(() => {});
    }
    const body = new Uint8Array(held);
    let at = 0;
    for (const chunk of chunks) {
        body.set(chunk, at);
        at += chunk.byteLength;
    }
    return body;
}

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

    // Refused on the sender's own word first, so an oversized body is turned away
    // before any of it is read. It is only a claim, which is why the read below
    // counts as well.
    const claimed = Number(request.headers.get("content-length"));
    if (Number.isFinite(claimed) && claimed > MOST_BYTES)
        return NextResponse.json({ error: "This presentation is too large." }, { status: 413 });

    const body = await readCapped(request, MOST_BYTES);
    if (!body)
        return NextResponse.json({ error: "This presentation is too large." }, { status: 413 });
    if (body.byteLength === 0)
        return NextResponse.json({ error: "No presentation was sent." }, { status: 400 });

    try {
        const deck = await renderPptxDeck(body, width);
        return NextResponse.json({ slides: deck.slides });
    } catch {
        // What went wrong is a detail of a file format, and naming it tells a
        // reader nothing they can act on. The screen says the presentation could
        // not be read.
        return NextResponse.json({ error: "This presentation could not be read." }, { status: 422 });
    }
}
