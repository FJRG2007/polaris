/**
 * Download one file of a quick-send transfer.
 *
 * POST, from the button on the link's page, never GET: a mail scanner or a chat
 * preview that opens a link would otherwise spend a one-time download before the
 * person it was meant for ever saw it. The download is counted before a byte is
 * sent, the name is only ever a header value, and the body is served as an
 * attachment the browser may not sniff or run.
 */

import { z } from "zod";
import { untrustedFileHeaders } from "@/lib/mime";
import { pipeThenDispose } from "@/lib/drive-stream";
import { rateLimit } from "@/lib/rate-limit-service";
import { clientIp, hashForLog } from "@/lib/request-context";
import { claimDownload, openTransferStorage } from "@/lib/disposable-transfer-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Downloads one address may start per minute, across every transfer. */
const PER_MINUTE = 30;

const paramsSchema = z.object({
    token: z.string().min(16).max(128),
    fileId: z.string().uuid()
});

export async function POST(
    _request: Request,
    { params }: { params: Promise<{ token: string; fileId: string }> }
): Promise<Response> {
    const parsed = paramsSchema.safeParse(await params);
    if (!parsed.success) return new Response(null, { status: 404 });

    const address = hashForLog(await clientIp()) ?? "unknown";
    const limited = await rateLimit(`quick-send:${address}`, PER_MINUTE, 60_000);
    if (!limited.ok) {
        return new Response(null, {
            status: 429,
            headers: { "retry-after": String(Math.ceil(limited.retryAfterMs / 1000)) }
        });
    }

    const claim = await claimDownload(parsed.data.token, parsed.data.fileId);
    if (!claim.ok) return new Response(null, { status: claim.reason === "missing" ? 404 : 410 });

    const { file } = claim;
    const driver = await openTransferStorage(file.targetId).catch(() => null);
    if (!driver) return new Response(null, { status: 503 });
    try {
        const stream = await driver.readStream(file.path);
        return new Response(pipeThenDispose(stream, driver), {
            status: 200,
            headers: {
                "content-type": "application/octet-stream",
                ...untrustedFileHeaders("application/octet-stream"),
                "content-length": String(file.size),
                "cache-control": "no-store",
                "referrer-policy": "no-referrer",
                "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`
            }
        });
    } catch (caught) {
        console.error(caught);
        await driver.dispose().catch(() => undefined);
        return new Response(null, { status: 410 });
    }
}
