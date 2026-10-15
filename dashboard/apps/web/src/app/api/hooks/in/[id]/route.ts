/**
 * The public end of an inbound webhook: a signed POST here redeploys the one
 * service the hook was made for. No session - the signature is the credential.
 * See `lib/deploy/inbound-hooks` for what a request has to carry.
 */

import { originIp } from "@polaris/core";
import { readCappedBody } from "@/lib/request-body";
import { MAX_BODY_BYTES, receiveInbound } from "@/lib/deploy/inbound-hooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
    const { id } = await context.params;
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) return Response.json({ error: "Body too large." }, { status: 413 });
    const bytes = await readCappedBody(request, MAX_BODY_BYTES).catch(() => null);
    if (!bytes) return Response.json({ error: "Body too large." }, { status: 413 });
    try {
        const outcome = await receiveInbound({
            id,
            ip: originIp(request.headers) ?? null,
            headers: {
                delivery: request.headers.get("x-polaris-delivery"),
                timestamp: request.headers.get("x-polaris-timestamp"),
                signature: request.headers.get("x-polaris-signature")
            },
            body: new TextDecoder().decode(bytes)
        });
        return outcome.status === 202
            ? Response.json({ deploymentId: outcome.deploymentId }, { status: 202 })
            : Response.json({ error: outcome.reason }, { status: outcome.status });
    } catch (error) {
        // A deploy that would not start names internals; the caller gets a sentence.
        console.error("polaris: inbound webhook failed:", error);
        return Response.json({ error: "The deploy could not be started." }, { status: 500 });
    }
}
