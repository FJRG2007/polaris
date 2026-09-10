/** POST /api/v1/deploy/services/:id/stop - stop the service without removing
 *  its deployment. */

import { power } from "@/lib/deploy/api/surface";
import { deployRoute, respond } from "@/lib/deploy/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = deployRoute("stop the service", true, async ({ caller, url, params }) => {
    await power(caller, params.id ?? "", "stop");
    return respond(url, { stopped: true }, () => "stopped\n");
});
