// whether the reader follows a server. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { serverFollowStateAction } from "@/app/(app)/apps/servers/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ hostId: z.string().trim().min(1).max(200) }),
    ({ hostId }) => serverFollowStateAction(hostId)
);
