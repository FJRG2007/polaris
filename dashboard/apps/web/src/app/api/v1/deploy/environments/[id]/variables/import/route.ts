/** POST /api/v1/deploy/environments/:id/variables/import - read a `.env` file's
 *  contents into the environment's shared variables: `{ text, secret }`. */

import { importRoute } from "@/lib/deploy/api/variable-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = importRoute((params) => ({
    kind: "environment",
    environmentId: params.id ?? ""
}));
