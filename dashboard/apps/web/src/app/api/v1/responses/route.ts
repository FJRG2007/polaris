/** The OpenAI Responses API in front of Polar (`lib/polar/compat`). */

import { withKeyUsage } from "@/lib/api-usage/recorder";
import { compatProbe } from "@/lib/polar/compat/auth";
import { createResponse } from "@/lib/polar/compat/responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withKeyUsage(createResponse);

const probe = withKeyUsage(compatProbe("POST, HEAD, OPTIONS", "openai"));
export const HEAD = probe;
export const OPTIONS = probe;
