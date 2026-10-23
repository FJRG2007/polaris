// the agents, repositories and machines a new session can use. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { sessionChoicesAction } from "@/app/(app)/apps/agents/sessions/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => sessionChoicesAction());
