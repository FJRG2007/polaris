// where a container's folder opens in Drive. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { actionRoute } from "@/lib/poll-route";
import { containerDriveLinkAction } from "@/app/(app)/apps/containers/[containerId]/drive-link-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = actionRoute(z.object({ input: z.unknown() }), ({ input }) =>
    containerDriveLinkAction(input)
);
