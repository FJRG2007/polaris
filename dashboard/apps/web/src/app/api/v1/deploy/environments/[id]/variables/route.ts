/**
 * GET  /api/v1/deploy/environments/:id/variables - the variables every service
 *      in the environment shares, secrets withheld.
 * POST /api/v1/deploy/environments/:id/variables - set one: `{ key, value, secret }`.
 */

import { variableRoutes } from "@/lib/deploy/api/variable-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, POST } = variableRoutes((params) => ({
    kind: "environment",
    environmentId: params.id ?? ""
}));
