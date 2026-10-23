// who the invite dialog lists. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { inviteCandidatesAction } from "@/app/(app)/chat/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ spaceId: z.string().trim().min(1).max(200), query: z.string().max(200).optional() }),
    ({ spaceId, query }) => inviteCandidatesAction({ spaceId, query })
);
