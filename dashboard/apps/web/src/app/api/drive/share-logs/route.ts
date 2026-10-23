// who opened a shared link. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { getShareLogsAction } from "@/app/(app)/drive/share-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ shareId: z.string().trim().min(1).max(200) }),
    ({ shareId }) => getShareLogsAction(shareId)
);
