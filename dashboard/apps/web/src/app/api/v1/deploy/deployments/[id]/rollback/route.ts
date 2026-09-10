/** POST /api/v1/deploy/deployments/:id/rollback - make this earlier deployment
 *  the service's running release again. */

import { idSchema } from "@/lib/deploy/api/schemas";
import { rollback } from "@/lib/deploy/api/surface";
import { deployRoute, respond } from "@/lib/deploy/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = deployRoute("roll back to that deployment", true, async ({ caller, url, params }) => {
    const { deploymentId } = await rollback(caller, idSchema.parse(params.id));
    return respond(url, { deploymentId }, () => `${deploymentId}\n`, 202);
});
