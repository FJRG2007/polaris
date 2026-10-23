// a volume's detail. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { volumeDetailAction } from "@/app/(app)/apps/deploy/project-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ volumeId: z.string().trim().min(1).max(200) }),
    ({ volumeId }) => volumeDetailAction(volumeId)
);
