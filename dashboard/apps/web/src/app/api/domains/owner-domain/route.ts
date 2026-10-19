// A domain of one's own, asked again while its certificate is ordered. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { jsonParam, pollRoute } from "@/lib/poll-route";
import { domainOwnerRefSchema } from "@/lib/owner-domain-caller";
import { readOwnerDomainAction } from "@/app/(app)/account/domains/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({
        owner: jsonParam.pipe(domainOwnerRefSchema),
        id: z.string().trim().min(1).max(100)
    }),
    ({ owner, id }) => readOwnerDomainAction(owner, id)
);
