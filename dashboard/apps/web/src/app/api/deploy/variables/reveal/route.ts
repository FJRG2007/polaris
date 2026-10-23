// a scope's variables, shown in the raw editor. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { revealEnvScopeAction } from "@/app/(app)/apps/deploy/variable-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({
        scope: z.string().trim().min(1).max(200),
        scopeId: z.string().trim().min(1).max(200)
    }),
    ({ scope, scopeId }) => revealEnvScopeAction({ scope, scopeId })
);
