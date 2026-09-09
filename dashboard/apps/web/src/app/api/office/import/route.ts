/**
 * A file, opened as a document.
 *
 * A route rather than a server action because it carries bytes: an action would
 * round-trip the whole file through the action encoding, and a spreadsheet is
 * routinely past the megabyte a server action is allowed by default - which
 * fails as a stack trace rather than as a sentence.
 *
 * Where the file came from is the browser's problem and not this one. The picker
 * on the screen already knows how to fetch what somebody chose out of Drive or
 * off an address, through the same guard everything else that reaches an outside
 * address goes through, and hands it over as an ordinary file - so this reads
 * one shape whatever the reader clicked.
 */

import * as core from "@polaris/core";
import { NextResponse } from "next/server";
import { apiPermission } from "@/lib/api-session";
import { readCappedBody } from "@/lib/request-body";
import { importFile, OfficeImportError } from "@/lib/office/import";
import { applyUpdate, createDocument, OfficeAccessError } from "@/lib/office/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * How big a file may be.
 *
 * The whole of it is read into memory and turned into a document that is then
 * held in one row, so this is not a limit about upload bandwidth - it is the
 * point past which the thing being made stops being a document somebody edits.
 */
const MAX_BYTES = 25 * 1024 * 1024;

/** The one sentence for a file past that, said the same way whether the size was
 *  declared or measured. */
function tooLarge(): Response {
    return NextResponse.json(
        { error: `That file is larger than ${Math.round(MAX_BYTES / (1024 * 1024))} MB.` },
        { status: 413 }
    );
}

/** The shelf the file is being opened onto, as the action layer bounds it. */
const shelfSchema = core.officeCreateSchema.pick({ orgId: true });

export async function POST(request: Request): Promise<Response> {
    const user = await apiPermission("office.use");
    if (user instanceof Response) return user;

    // What the request claims, refused before any of it is read. It is only a
    // claim - a request need not carry one at all, and `formData()` would have
    // the whole body in memory before `file.size` could disagree - which is why
    // the read below counts as well.
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BYTES) return tooLarge();

    const body = await readCappedBody(request, MAX_BYTES);
    if (!body) return tooLarge();
    if (body.byteLength === 0) {
        return NextResponse.json({ error: "No file was sent." }, { status: 400 });
    }

    const form = await new Response(body, {
        headers: { "content-type": request.headers.get("content-type") ?? "" }
    })
        .formData()
        .catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) {
        return NextResponse.json({ error: "No file was sent." }, { status: 400 });
    }

    // The organization shelf the reader is working from, when they are on one.
    // Sent by the screen rather than resolved here: the same file imported from
    // a company shelf belongs to the company. Whether it is a shelf they may
    // create on is `createDocument`'s answer, not this one's.
    const sent = form?.get("orgId");
    const shelf = shelfSchema.safeParse({ orgId: typeof sent === "string" ? sent : null });
    if (!shelf.success) {
        return NextResponse.json({ error: "That is not an organization." }, { status: 400 });
    }

    try {
        const imported = await importFile(file.name, new Uint8Array(await file.arrayBuffer()));
        const documentId = await createDocument(
            { id: user.id },
            { kind: imported.kind, title: imported.title, orgId: shelf.data.orgId || null }
        );
        await applyUpdate({ id: user.id }, documentId, imported.update);
        return NextResponse.json({ id: documentId, kind: imported.kind, title: imported.title });
    } catch (caught) {
        if (caught instanceof OfficeImportError) {
            return NextResponse.json({ error: caught.message }, { status: 400 });
        }
        // A shelf somebody may not create on is an answer, not a failure. The
        // arm below would log it as one and tell the reader their file could
        // not be read, which is not what happened to it.
        if (caught instanceof OfficeAccessError) {
            return NextResponse.json({ error: caught.message }, { status: 403 });
        }
        console.error("polaris: an office import failed:", caught);
        return NextResponse.json({ error: "That file could not be opened." }, { status: 500 });
    }
}
