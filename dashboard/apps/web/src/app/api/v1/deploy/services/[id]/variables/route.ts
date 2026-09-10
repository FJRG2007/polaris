/**
 * GET  /api/v1/deploy/services/:id/variables - the service's own variables,
 *      with every secret value withheld.
 * POST /api/v1/deploy/services/:id/variables - set one: `{ key, value, secret }`.
 *      `redeploy: true` redeploys the services already deployed to pick it up.
 */

import { variableRoutes } from "@/lib/deploy/api/variable-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, POST } = variableRoutes((params) => ({
    kind: "service",
    ref: params.id ?? ""
}));
