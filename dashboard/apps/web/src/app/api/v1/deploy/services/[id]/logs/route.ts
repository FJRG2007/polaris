/**
 * GET /api/v1/deploy/services/:id/logs - what the running container prints.
 *
 * `tail` bounds how many lines are read; `since` (the timestamp at the start of
 * the last line already printed) keeps only what came after it, which is how a
 * follow polls without printing a line twice. `?format=text` answers the raw
 * lines.
 */

import { z } from "zod";
import { runtimeLog } from "@/lib/deploy/api/surface";
import { tailSchema } from "@/lib/deploy/api/schemas";
import { deployRoute, queryOf, respond } from "@/lib/deploy/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
    tail: tailSchema,
    since: z.string().trim().max(64).optional()
});

export const GET = deployRoute(
    "read the service's logs",
    false,
    async ({ caller, url, params }) => {
        const query = querySchema.parse(queryOf(url));
        const { log } = await runtimeLog(caller, params.id ?? "", query);
        return respond(url, { log }, () => (log && !log.endsWith("\n") ? `${log}\n` : log));
    }
);
