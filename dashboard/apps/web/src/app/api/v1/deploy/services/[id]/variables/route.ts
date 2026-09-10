/**
 * GET  /api/v1/deploy/services/:id/variables - the service's own variables,
 *      with every secret value withheld.
 * POST /api/v1/deploy/services/:id/variables - set one: `{ key, value, secret }`.
 *      Services already deployed pick the change up with a redeploy.
 */

import { variableRoutes } from "@/lib/deploy/api/variable-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, POST } = variableRoutes((params) => ({ kind: "service", ref: params.id ?? "" }));
