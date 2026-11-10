// Whether a site has recorded anything yet, asked again by the guided setup until
// it has. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { checkInstallationAction } from "@/app/(app)/analytics/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ scopeType: z.string().trim().min(1).max(40), scopeId: z.string().max(80) }),
    (input) => checkInstallationAction(input)
);
