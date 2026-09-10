/**
 * GET /api/v1/deploy/deployments/:id - a deployment's status and build log.
 *
 * Three ways to read the log:
 * - `?tail=N` - the last N lines, for "why did it fail".
 * - `?offset=B` - everything from byte B, with `nextOffset` to pass back; how a
 *   client that cannot hold a stream open polls it.
 * - `?follow=1` - the log as plain text as it is written, from `offset`, until
 *   the deployment finishes. `curl -N` prints it as it arrives.
 */

import { z } from "zod";
import { idSchema, offsetSchema } from "@/lib/deploy/api/schemas";
import { deployRoute, queryOf, respond } from "@/lib/deploy/api/http";
import { deploymentLog, followDeploymentLog } from "@/lib/deploy/api/surface";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
    tail: z.coerce.number().int().min(1).max(5000).optional(),
    offset: offsetSchema,
    follow: z.enum(["1", "true", "0", "false"]).optional()
});

export const GET = deployRoute(
    "read the deployment",
    false,
    async ({ caller, request, url, params }) => {
        const id = idSchema.parse(params.id);
        const query = querySchema.parse(queryOf(url));
        if (query.follow === "1" || query.follow === "true") {
            const stream = await followDeploymentLog(caller, id, query.offset, request.signal);
            return new Response(stream, {
                headers: {
                    "content-type": "text/plain; charset=utf-8",
                    "cache-control": "no-store",
                    // Proxies that buffer would hold the whole build back until it
                    // finished, which is the one thing a follow must not do.
                    "x-accel-buffering": "no"
                }
            });
        }
        const result = await deploymentLog(caller, id, { offset: query.offset, tail: query.tail });
        return respond(url, result, () => result.log);
    }
);
