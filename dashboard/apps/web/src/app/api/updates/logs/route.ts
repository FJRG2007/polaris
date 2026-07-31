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
import type { UpdateLogTail } from "@/lib/update-log";
import { UPDATE_LOG_PATH as LOG_PATH } from "@/lib/update-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    // Whichever container answers this poll says which build it is. During a
    // no-downtime rollover both the old and the new one serve for a few seconds, so
    // the caller learns the update landed as soon as a request reaches the new one.
    const build = (process.env.POLARIS_BUILD_SHA ?? "").trim() || null;

    const notReadable = NextResponse.json({
        exists: false,
        content: "",
        nextOffset: 0,
        size: 0,
        done: false,
        exitCode: null,
        finished: false,
        updatedAt: 0,
        now: Date.now(),
        build
    } satisfies UpdateLogTail);
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
            // How much there is to read, so a caller wanting the end of a finished
            // run can ask for it directly instead of walking the whole file to
            // reach it.
            size: info.size,
            done,
            // From the marker alone. Gating it on `done` tied a fact about the run
            // to how far this particular caller had read, so a page that had only
            // read the first chunk could not tell a failed run from a live one.
            exitCode: match ? Number(match[1]) : null,
            // Whether the run has ended at all, independent of how far the caller has
            // read, plus when the file was last written. A client that just loaded the
            // page uses both to tell a live update from a leftover log. Both timestamps
            // come from here so the age of a run is never measured against a browser
            // clock that disagrees with the host's.
            finished: match !== null,
            updatedAt: info.mtimeMs,
            now: Date.now(),
            build
        } satisfies UpdateLogTail);
    } finally {
        await handle.close();
    }
}
