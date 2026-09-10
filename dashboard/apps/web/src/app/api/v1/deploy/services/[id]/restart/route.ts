/** POST /api/v1/deploy/services/:id/restart - recreate the running container
 *  from the service's current configuration. */

import { power } from "@/lib/deploy/api/surface";
import { deployRoute, respond } from "@/lib/deploy/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = deployRoute("restart the service", true, async ({ caller, url, params }) => {
    await power(caller, params.id ?? "", "restart");
    return respond(url, { restarted: true }, () => "restarted\n");
});
