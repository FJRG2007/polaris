/** The model ids an API key's owner can address (`lib/polar/compat/models.ts`). */

import { listModels } from "@/lib/polar/compat/models";
import { withKeyUsage } from "@/lib/api-usage/recorder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withKeyUsage(listModels);
