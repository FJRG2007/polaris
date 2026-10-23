// how the deployment is reached. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { apiAdmin } from "@/lib/api-session";
import { pollRoute } from "@/lib/poll-route";
import { networkStatusAction } from "@/app/(app)/admin/domains/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const read = pollRoute(z.object({}), () => networkStatusAction());

// Operator only, said here as every admin route says it; the action checks again.
export async function GET(request: Request): Promise<Response> {
    const refused = await apiAdmin();
    if (refused instanceof Response) return refused;
    return read(request);
}
