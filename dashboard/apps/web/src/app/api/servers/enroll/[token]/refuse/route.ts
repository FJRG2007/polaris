/**
 * Where the enrollment script says it stopped before claiming. Unauthenticated
 * except for the token in the path, and unlike the claim it burns nothing: the
 * command it belongs to still works once whatever the machine refused over is
 * fixed.
 *
 * Two things keep an open endpoint from being useful to a stranger. The body is a
 * reason CODE from a closed set, so nobody can write a sentence of their own into
 * an operator's dashboard - Polaris holds the wording. And the answer is the same
 * whether or not the token names anything, so this cannot be used to sort live
 * tokens from dead ones.
 */

import { clientIp } from "@/lib/request-context";
import { refuseEnrollmentSchema } from "@polaris/core";
import { refuseEnrollment } from "@/lib/enrollment-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
    const { token } = await params;

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return Response.json({ ok: false, error: "Malformed report" }, { status: 400 });
    }

    const parsed = refuseEnrollmentSchema.safeParse(body);
    if (!parsed.success) return Response.json({ ok: false, error: "Unknown reason" }, { status: 400 });

    await refuseEnrollment(token, parsed.data.reason, await clientIp());
    // Always the same answer. The script ignores it either way - it is about to
    // print its own diagnosis and exit - and a caller learns nothing from it.
    return Response.json({ ok: true });
}
