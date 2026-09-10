/** DELETE /api/v1/deploy/variables/:id - remove one variable. Services already
 *  deployed pick the change up with a redeploy. */

import { idSchema } from "@/lib/deploy/api/schemas";
import { deleteVariable } from "@/lib/deploy/api/surface";
import { deployRoute, respond } from "@/lib/deploy/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DELETE = deployRoute("remove the variable", true, async ({ caller, url, params }) => {
    const id = idSchema.parse(params.id);
    await deleteVariable(caller, id);
    return respond(url, { removed: id }, () => "removed\n");
});
