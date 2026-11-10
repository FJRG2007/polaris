/** OpenAI Chat Completions in front of Polar (`lib/polar/compat`). */

import { withKeyUsage } from "@/lib/api-usage/recorder";
import { compatProbe } from "@/lib/polar/compat/auth";
import { createChatCompletion } from "@/lib/polar/compat/chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withKeyUsage(createChatCompletion);

const probe = withKeyUsage(compatProbe("POST, HEAD, OPTIONS", "openai"));
export const HEAD = probe;
export const OPTIONS = probe;
