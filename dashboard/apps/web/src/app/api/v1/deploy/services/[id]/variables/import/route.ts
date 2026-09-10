/** POST /api/v1/deploy/services/:id/variables/import - read a `.env` file's
 *  contents into the service: `{ text, secret }`. */

import { importRoute } from "@/lib/deploy/api/variable-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = importRoute((params) => ({ kind: "service", ref: params.id ?? "" }));
