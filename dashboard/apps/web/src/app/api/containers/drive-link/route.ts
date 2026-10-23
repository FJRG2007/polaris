// where a container's folder opens in Drive. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { jsonParam, pollRoute } from "@/lib/poll-route";
import { containerDriveLinkAction } from "@/app/(app)/apps/containers/[containerId]/drive-link-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({ input: jsonParam }), ({ input }) =>
    containerDriveLinkAction(input)
);
