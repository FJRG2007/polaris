/**
 * Where the enrollment script reports what it provisioned. Unauthenticated except
 * for the token in the path, which is burned on the first call.
 *
 * The body is written by a script on a machine Polaris has never spoken to, so it
 * is validated as a claim rather than read as fact: the schema bounds it, and the
 * service prefers the address this request actually arrived from over anything
 * the payload says about where the machine lives.
 */

import { clientIp } from "@/lib/request-context";
import { claimEnrollmentSchema } from "@polaris/core";
import { claimEnrollment } from "@/lib/enrollment-service";

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

    const parsed = claimEnrollmentSchema.safeParse(body);
    if (!parsed.success) {
        return Response.json(
            { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid report" },
            { status: 400 }
        );
    }

    const result = await claimEnrollment(token, parsed.data, await clientIp());
    // 200 on refusal as well: the script reads the body, and an HTTP error would
    // have it print a status code instead of the sentence explaining what to fix.
    return Response.json(result);
}
