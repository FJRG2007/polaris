/**
 * GET /api/v1/deploy/services?ref=project/service - find a service by name.
 *
 * `ref` is an id, `project/service` (the project's default environment) or
 * `project/environment/service`. The answer is the same as reading the service
 * by id, so a script resolves a name once and uses the id from then on.
 */

import { z } from "zod";
import { getService } from "@/lib/deploy/api/surface";
import { serviceRefSchema } from "@/lib/deploy/api/schemas";
import { deployRoute, queryOf, respond } from "@/lib/deploy/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({ ref: serviceRefSchema });

export const GET = deployRoute("find the service", false, async ({ caller, url }) => {
    const { ref } = querySchema.parse(queryOf(url));
    const service = await getService(caller, ref);
    return respond(url, { service }, () => `${service.id}\n`);
});
