// a scope's firewall rule and what it inherits. A route, not an action: see lib/poll-route.
import { z } from "zod";
import * as core from "@polaris/core";
import { pollRoute } from "@/lib/poll-route";
import { getWafRuleAction } from "@/app/(app)/apps/firewall/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ scopeType: z.enum(core.WAF_SCOPE_TYPES), scopeId: z.string().max(200) }),
    ({ scopeType, scopeId }) => getWafRuleAction({ scopeType, scopeId })
);
