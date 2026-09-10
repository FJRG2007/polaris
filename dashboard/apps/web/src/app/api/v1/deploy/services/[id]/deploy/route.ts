/**
 * POST /api/v1/deploy/services/:id/deploy - deploy the service's configured
 * source. Answers 202 with the deployment id at once; follow the build with
 * GET /api/v1/deploy/deployments/:id?follow=1.
 */

import { deploy } from "@/lib/deploy/api/surface";
import { deployRoute, respond } from "@/lib/deploy/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = deployRoute("deploy the service", true, async ({ caller, url, params }) => {
    const { deploymentId } = await deploy(caller, params.id ?? "");
    return respond(url, { deploymentId }, () => `${deploymentId}\n`, 202);
});
