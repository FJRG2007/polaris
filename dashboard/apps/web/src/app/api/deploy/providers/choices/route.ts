// what a provider account can deploy into. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { listProviderChoicesAction } from "@/app/(app)/apps/deploy/external-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ connectionId: z.string().trim().min(1).max(200) }),
    ({ connectionId }) => listProviderChoicesAction(connectionId)
);
