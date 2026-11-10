/** Anthropic token count, estimated (`lib/polar/compat/tokens.ts`). */

import { withKeyUsage } from "@/lib/api-usage/recorder";
import { compatProbe } from "@/lib/polar/compat/auth";
import { countTokens } from "@/lib/polar/compat/messages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withKeyUsage(countTokens);

const probe = withKeyUsage(compatProbe("POST, HEAD, OPTIONS", "anthropic"));
export const HEAD = probe;
export const OPTIONS = probe;
