/**
 * Serves the enrollment script for one token. Unauthenticated by necessity: it is
 * fetched by `curl` on a machine that has no Polaris session and no credentials.
 *
 * The token is the whole credential, so this endpoint gives away nothing beyond
 * a public key and a callback URL, and does not distinguish an unknown token from
 * a spent or expired one. Nothing is burned here - the script still has to call
 * back - which is what lets a flaky download be retried.
 */

import { clientIp } from "@/lib/request-context";
import { appBaseUrl } from "@/lib/domain-service";
import { enrollmentScript } from "@/lib/enrollment-script";
import { resolveEnrollment } from "@/lib/enrollment-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
    const { token } = await params;
    const enrollment = await resolveEnrollment(token, await clientIp());
    if (!enrollment) {
        // Written as a shell comment plus a failing command: the body is about to
        // be piped straight into `sh`, so it must say what happened AND not
        // silently succeed.
        return new Response(EXPIRED_SCRIPT, { status: 404, headers: SCRIPT_HEADERS });
    }

    const script = enrollmentScript({
        baseUrl: await appBaseUrl(),
        token,
        username: enrollment.username,
        publicKey: enrollment.publicKey
    });
    return new Response(script, { status: 200, headers: SCRIPT_HEADERS });
}

/** What a dead token gets. The body is piped straight into `sh`, so it has to
 *  both explain itself and fail - a 404 page would be executed as a script. */
const EXPIRED_SCRIPT = `# This enrollment command is no longer valid.
echo "polaris: this command has expired or was already used - generate a new one" >&2
exit 1
`;

/** Plain text so a browser shows the script rather than downloading it, and never
 *  cached - a token is single-use and a cached copy would outlive it. */
const SCRIPT_HEADERS = {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
} as const;
