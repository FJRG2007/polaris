/** The Anthropic Messages API in front of Polar (`lib/polar/compat`). */

import { withKeyUsage } from "@/lib/api-usage/recorder";
import { compatProbe } from "@/lib/polar/compat/auth";
import { createMessage } from "@/lib/polar/compat/messages";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withKeyUsage(createMessage);

const probe = withKeyUsage(compatProbe("POST, HEAD, OPTIONS", "anthropic"));
export const HEAD = probe;
export const OPTIONS = probe;
