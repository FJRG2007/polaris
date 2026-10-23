// who an item is shared with. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { listItemSharesAction } from "@/app/(app)/drive/sharing-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ connectionId: z.string().trim().min(1).max(200), path: z.string().max(4096) }),
    ({ connectionId, path }) => listItemSharesAction(connectionId, path)
);
