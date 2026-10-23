// how long a step-up proof is still good. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { stepUpRemainingAction } from "@/app/(app)/account/step-up-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ purpose: z.string().trim().min(1).max(200) }),
    ({ purpose }) => stepUpRemainingAction(purpose)
);
