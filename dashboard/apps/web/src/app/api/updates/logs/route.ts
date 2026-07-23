/**
 * Live update-log tail. During an in-band update, hostd streams the updater's
 * output to a file on the shared polaris-run volume (see POLARIS_HOSTD_UPDATE_CMD);
 * this endpoint serves it by byte offset so the dashboard can poll it and show the
 * update in real time - and, because the poll resumes from an offset, it survives
 * the web container being recreated mid-update. Admin-only: the log carries host
 * detail. The updater appends a `POLARIS_UPDATE_EXIT=<code>` marker on completion,
 * which is surfaced as `done` + `exitCode` so the UI can stop and report pass/fail.
 */

import { NextResponse, type NextRequest } from "next/server";
import { open, stat } from "node:fs/promises";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOG_PATH = process.env.POLARIS_UPDATE_LOG ?? "/run/polaris/update.log";
/** Cap per poll so one response can never be unbounded on a huge build log. */
const MAX_CHUNK = 128 * 1024;
const MARKER = /POLARIS_UPDATE_EXIT=(-?\d+)/;

export async function GET(request: NextRequest): Promise<Response> {
    const session = await getSession();
    if (!(session?.user as { isAdmin?: boolean } | undefined)?.isAdmin) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const raw = Number(request.nextUrl.searchParams.get("offset") ?? "0");
    let offset = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;

    const notReadable = NextResponse.json({ exists: false, content: "", nextOffset: 0, done: false, exitCode: null });
    const info = await stat(LOG_PATH).catch(() => null);
    if (!info || !info.isFile()) return notReadable;
    // A new run truncates the file; if our offset is past its end, restart from 0.
    if (offset > info.size) offset = 0;

    // Any read failure (e.g. the file not yet readable) degrades to "no log" so the
    // caller falls back to the health-based reload rather than seeing a 500.
    const handle = await open(LOG_PATH, "r").catch(() => null);
    if (!handle) return notReadable;
    try {
        const length = Math.min(MAX_CHUNK, info.size - offset);
        let content = "";
        if (length > 0) {
            const buffer = Buffer.alloc(length);
            await handle.read(buffer, 0, length, offset);
            content = buffer.toString("utf8");
        }
        // Advance by bytes read (not decoded length) so a multibyte char split at the
        // chunk boundary never drifts the offset.
        const nextOffset = offset + length;
        // Detect the completion marker from the file tail, independent of chunking.
        const tailStart = Math.max(0, info.size - 128);
        const tailLength = info.size - tailStart;
        let match: RegExpExecArray | null = null;
        if (tailLength > 0) {
            const tail = Buffer.alloc(tailLength);
            await handle.read(tail, 0, tailLength, tailStart);
            match = MARKER.exec(tail.toString("utf8"));
        }
        const done = match !== null && nextOffset >= info.size;
        return NextResponse.json({
            exists: true,
            content,
            nextOffset,
            done,
            exitCode: done && match ? Number(match[1]) : null
        });
    } finally {
        await handle.close();
    }
}
