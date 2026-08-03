/**
 * Where Google returns somebody after they authorize their account.
 *
 * A fixed path rather than a dynamic one, because it is registered as a redirect
 * URI on the operator's OAuth client: Google refuses anything it was not told
 * about in advance.
 */

import { finishConnectionLink } from "@/lib/connections/link-flow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    return finishConnectionLink(request, "google");
}
