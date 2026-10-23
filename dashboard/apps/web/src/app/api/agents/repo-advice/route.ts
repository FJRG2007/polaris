// how a repository is best run, and what may run it. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { jsonParam, pollRoute } from "@/lib/poll-route";
import { adviseRepoAction } from "@/app/(app)/apps/agents/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({ input: jsonParam }), ({ input }) =>
    adviseRepoAction(input)
);
