/** POST /api/v1/deploy/deployments/:id/cancel - stop a deploy that is still
 *  queued or building. */

import { idSchema } from "@/lib/deploy/api/schemas";
import { cancelDeployment } from "@/lib/deploy/api/surface";
import { deployRoute, respond } from "@/lib/deploy/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = deployRoute("cancel the deployment", true, async ({ caller, url, params }) => {
    const id = idSchema.parse(params.id);
    await cancelDeployment(caller, id);
    return respond(url, { cancelled: id }, () => "cancelled\n");
});
