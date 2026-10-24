// what fixing a domain's mail security would change. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { jsonParam, pollRoute } from "@/lib/poll-route";
import { planDomainSecurityAction } from "@/app/(app)/account/domains/security-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The JSON is the action's own to check: it parses what it is handed with its schema.
export const GET = pollRoute(
    z.object({
        ref: jsonParam,
        domain: z.string().trim().min(1).max(200),
        policy: jsonParam,
        reportTo: z.string().max(254).optional()
    }),
    ({ ref, domain, policy, reportTo }) =>
        planDomainSecurityAction(
            ref as Parameters<typeof planDomainSecurityAction>[0],
            domain,
            policy as Parameters<typeof planDomainSecurityAction>[2],
            reportTo || null
        )
);
