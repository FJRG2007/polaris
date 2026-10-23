// the people and groups a runner can be scoped to. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { runnerPrincipalsAction } from "@/app/(app)/apps/runners/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => runnerPrincipalsAction());
