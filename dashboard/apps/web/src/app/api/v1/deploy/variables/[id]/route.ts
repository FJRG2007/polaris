/** DELETE /api/v1/deploy/variables/:id - remove one variable. `?redeploy=1`
 *  redeploys the services already deployed so they pick the change up. */

import { deleteVariable } from "@/lib/deploy/api/surface";
import { redeploying } from "@/lib/deploy/api/variable-routes";
import { idSchema, redeployQuerySchema } from "@/lib/deploy/api/schemas";
import { deployRoute, queryOf, respond } from "@/lib/deploy/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DELETE = deployRoute("remove the variable", true, async ({ caller, url, params }) => {
    const id = idSchema.parse(params.id);
    const { redeploy } = redeployQuerySchema.parse(queryOf(url));
    const { redeployed } = await deleteVariable(caller, id, { redeploy });
    return respond(url, { removed: id, redeployed }, () => `removed${redeploying(redeployed)}\n`);
});
