// a space's vocabulary for a new task. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { createContextAction } from "@/app/(app)/tasks/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({
        spaceId: z.string().trim().min(1).max(200),
        folderId: z.string().trim().min(1).max(200).optional()
    }),
    ({ spaceId, folderId }) => createContextAction(spaceId, folderId ?? null)
);
