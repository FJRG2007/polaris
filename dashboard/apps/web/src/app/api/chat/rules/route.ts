// the instance's chat rules. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { chatRulesAction } from "@/app/(app)/chat/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => chatRulesAction());
