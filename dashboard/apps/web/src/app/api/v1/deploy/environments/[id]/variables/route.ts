/**
 * GET  /api/v1/deploy/environments/:id/variables - the variables every service
 *      in the environment shares, secrets withheld.
 * POST /api/v1/deploy/environments/:id/variables - set one: `{ key, value, secret }`.
 *      `redeploy: true` redeploys the services already deployed to pick it up.
 */

import { variableRoutes } from "@/lib/deploy/api/variable-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, POST } = variableRoutes((params) => ({
    kind: "environment",
    environmentId: params.id ?? ""
}));
