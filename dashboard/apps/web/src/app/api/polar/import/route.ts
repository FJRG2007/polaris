/**
 * POST /api/polar/import - a Polar chat export (`.json`, format version 1), or
 * an OpenCode session export (`opencode export`), as a new chat of the
 * signed-in person. The body is the file itself, capped at
 * `MAX_IMPORT_BYTES` while it is read; only the words come over (see
 * `lib/polar/import.ts`), so nothing in the file runs. A few per ten minutes.
 */

import { NextResponse } from "next/server";
import { polarCaller } from "@/lib/polar/access";
import { rateLimit } from "@/lib/rate-limit-service";
import { getTranslations } from "@/lib/i18n/request";
import * as imports from "@/lib/polar/import";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The body as text, or null once it passes `limit` bytes. */
async function cappedText(request: Request, limit: number): Promise<string | null> {
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > limit) return null;
    if (!request.body) return "";
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
            await reader.cancel();
            return null;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
}

export async function POST(request: Request): Promise<Response> {
    const user = await polarCaller();
    if (user instanceof NextResponse) return user;
    // JSON only: a cross-site form cannot send it without a preflight.
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
        return NextResponse.json({ error: "json" }, { status: 415 });
    const limited = await rateLimit(`polar-import:${user.id}`, 10, 10 * 60_000);
    if (!limited.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    const text = await cappedText(request, imports.MAX_IMPORT_BYTES);
    if (text === null) return NextResponse.json({ error: "large" }, { status: 413 });
    const parsed = imports.parseThreadImport(text);
    if ("refusal" in parsed) return NextResponse.json({ error: parsed.refusal }, { status: 400 });
    const t = await getTranslations("polar");
    const id = await imports.importThread(user.id, parsed.thread, t("settings.data.importedTitle"));
    return NextResponse.json({ id });
}
