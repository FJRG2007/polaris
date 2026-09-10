/** POST /api/v1/deploy/services/:id/start - start a stopped service again. */

import { power } from "@/lib/deploy/api/surface";
import { deployRoute, respond } from "@/lib/deploy/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = deployRoute("start the service", true, async ({ caller, url, params }) => {
    await power(caller, params.id ?? "", "start");
    return respond(url, { started: true }, () => "started\n");
});
