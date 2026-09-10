/**
 * Upload a DMARC aggregate report by hand: the file a receiver sent (.xml,
 * .xml.gz, .zip) or the whole message it came in (.eml). A route rather than a
 * server action because a report can be larger than an action's body allows.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import { NextResponse } from "next/server";
import { guardedUser, sessionCan } from "@/lib/session";
import { DmarcUploadError, uploadReport } from "@/lib/mail-server/dmarc-report";
import { MailServerUnreachable } from "@/lib/mail-server/transport";
import { MailServerAccessError, requireServer } from "@/lib/mail-server/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The largest report accepted. Real ones are a few hundred kilobytes. */
const MAX_UPLOAD = 10 * 1024 * 1024;

const idSchema = z.string().uuid();

export async function POST(
    request: Request,
    context: { params: Promise<{ id: string }> }
): Promise<Response> {
    const user = await guardedUser();
    if (!user || !(await sessionCan(user, "mailserver.manage"))) {
        return NextResponse.json({ error: "You cannot manage mail servers." }, { status: 403 });
    }
    const { id } = await context.params;
    const serverId = idSchema.safeParse(id);
    if (!serverId.success)
        return NextResponse.json({ error: "That mail server was not found." }, { status: 404 });
    let server;
    try {
        server = await requireServer({ id: user.id, isAdmin: user.isAdmin }, serverId.data);
    } catch {
        return NextResponse.json({ error: "That mail server was not found." }, { status: 404 });
    }
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > MAX_UPLOAD + 64 * 1024) {
        return NextResponse.json(
            { error: "That file is larger than any real report." },
            { status: 413 }
        );
    }
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File))
        return NextResponse.json({ error: "Choose a report file." }, { status: 400 });
    if (file.size > MAX_UPLOAD)
        return NextResponse.json(
            { error: "That file is larger than any real report." },
            { status: 413 }
        );
    try {
        const result = await uploadReport(server, new Uint8Array(await file.arrayBuffer()));
        return NextResponse.json(result);
    } catch (error) {
        if (
            error instanceof DmarcUploadError ||
            error instanceof core.DmarcReportError ||
            error instanceof core.StalwartRefusal ||
            error instanceof MailServerAccessError ||
            error instanceof MailServerUnreachable
        ) {
            return NextResponse.json({ error: error.message }, { status: 400 });
        }
        console.error("polaris: DMARC upload failed:", error);
        return NextResponse.json({ error: "That report could not be read." }, { status: 500 });
    }
}
