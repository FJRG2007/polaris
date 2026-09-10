/** DELETE /api/v1/deploy/domains/:id - detach a hostname from its service. */

import { idSchema } from "@/lib/deploy/api/schemas";
import { removeDomain } from "@/lib/deploy/api/surface";
import { deployRoute, respond } from "@/lib/deploy/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DELETE = deployRoute("remove the domain", true, async ({ caller, url, params }) => {
    const id = idSchema.parse(params.id);
    await removeDomain(caller, id);
    return respond(url, { removed: id }, () => "removed\n");
});
