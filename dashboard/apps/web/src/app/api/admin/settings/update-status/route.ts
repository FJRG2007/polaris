// Whether an update is out, asked again while Settings is open. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { apiAdmin } from "@/lib/api-session";
import { pollRoute } from "@/lib/poll-route";
import { checkUpdatesAction } from "@/app/(app)/admin/settings/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const read = pollRoute(z.object({ force: z.enum(["true", "false"]) }), ({ force }) =>
    checkUpdatesAction(force === "true")
);

// Operator only, said here as every admin route says it; the action checks again.
export async function GET(request: Request): Promise<Response> {
    const refused = await apiAdmin();
    if (refused instanceof Response) return refused;
    return read(request);
}
