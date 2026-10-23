// a person's profile card. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { getUserProfileAction } from "@/app/(app)/drive/activity-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ userId: z.string().trim().min(1).max(200) }),
    ({ userId }) => getUserProfileAction(userId)
);
