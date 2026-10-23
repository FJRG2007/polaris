// the repositories and agents a task can be handed to. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { agentHandoffChoicesAction } from "@/app/(app)/tasks/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => agentHandoffChoicesAction());
