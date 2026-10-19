// Whether a DNS record has reached the public resolvers, asked again until it has. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { jsonParam, pollRoute } from "@/lib/poll-route";
import { dnsScopeSchema } from "@/lib/owner-domain-caller";
import { dnsPropagationAction } from "@/app/(app)/account/domains/dns-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({
        scope: jsonParam.pipe(dnsScopeSchema),
        recordId: z.string().trim().min(1).max(100)
    }),
    ({ scope, recordId }) => dnsPropagationAction(scope, recordId)
);
