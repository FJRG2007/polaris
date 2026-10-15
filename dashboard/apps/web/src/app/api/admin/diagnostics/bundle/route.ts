/**
 * The support bundle: `?preview=1` lists what it holds, without it the archive
 * downloads.
 *
 * The preview names the files and lists the configuration exactly as the
 * archive carries it, from the same `redactConfig`. The download is rate
 * limited per admin: each one runs the whole diagnosis, which goes out to the
 * network.
 *
 * Admin-only. Node runtime for Prisma and the archive.
 */

import { z } from "zod";
import { NextResponse } from "next/server";
import { apiAdmin } from "@/lib/api-session";
import { rateLimit } from "@/lib/rate-limit-service";
import { downloadTicketHeaders } from "@/lib/download-ticket";
import { bundleFiles, bundleZip, redactConfig } from "@/lib/diagnostics/support-bundle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({ preview: z.enum(["1"]).optional() });
const LIMIT = 10;
const WINDOW_MS = 10 * 60 * 1000;

export async function GET(request: Request): Promise<Response> {
    const caller = await apiAdmin();
    if (caller instanceof Response) return caller;
    const parsed = querySchema.safeParse({
        preview: new URL(request.url).searchParams.get("preview") ?? undefined
    });
    if (!parsed.success) return NextResponse.json({ error: "bad request" }, { status: 400 });

    if (parsed.data.preview) {
        // The preview is a description, not a run: what each file is and which
        // settings ride along. Building the files for it would probe the network
        // twice for one download.
        return NextResponse.json(
            {
                files: [
                    "manifest.json",
                    "diagnosis.json",
                    "errors.json",
                    "config.json",
                    "speed-test.json"
                ],
                config: redactConfig(process.env)
            },
            { headers: { "Cache-Control": "no-store" } }
        );
    }

    const allowed = await rateLimit(`diagnostics:bundle:${caller.id}`, LIMIT, WINDOW_MS);
    if (!allowed.ok)
        return NextResponse.json(
            { error: "rate limited" },
            {
                status: 429,
                headers: { "Retry-After": String(Math.ceil(allowed.retryAfterMs / 1000)) }
            }
        );

    const zip = await bundleZip(await bundleFiles());
    const day = new Date().toISOString().slice(0, 10);
    return new Response(new Uint8Array(zip), {
        headers: {
            "Content-Type": "application/zip",
            // Says "this download has started" to a page that sent a ticket - see
            // `download-ticket`. Nothing at all when none was sent.
            ...downloadTicketHeaders(request),
            "Content-Disposition": `attachment; filename="polaris-support-${day}.zip"`,
            "Cache-Control": "no-store"
        }
    });
}
