/**
 * Download the local CA root certificate so the operator can install it as a trust
 * anchor and stop seeing the browser warning on polaris.local. Public material (the
 * root cert, never the CA private key); gated behind a logged-in session only to
 * keep it off anonymous scanners. Served as a .crt attachment.
 */

import { readLocalCaRoot } from "@/lib/local-ca-service";
import { apiUser } from "@/lib/api-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const refused = await apiUser();
    if (refused instanceof Response) return refused;
    const pem = await readLocalCaRoot();
    if (!pem) return new Response("The local certificate authority is not available yet.", { status: 404 });
    return new Response(pem, {
        headers: {
            "content-type": "application/x-x509-ca-cert",
            "content-disposition": 'attachment; filename="polaris-local-ca.crt"'
        }
    });
}
