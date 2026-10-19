// How a machine's enrollment is going, asked again until it joins. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { enrollmentStatusAction } from "@/app/(app)/apps/servers/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({ id: z.string().trim().min(1).max(100) }), ({ id }) =>
    enrollmentStatusAction(id)
);
