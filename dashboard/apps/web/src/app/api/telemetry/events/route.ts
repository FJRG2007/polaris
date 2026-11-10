// Telemetry: a project's or an issue's events, one page at a time. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { jsonParam, pollRoute } from "@/lib/poll-route";
import { eventsPageAction } from "@/app/(app)/telemetry/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The action parses the input with its own schema.
export const GET = pollRoute(z.object({ input: jsonParam }), ({ input }) => eventsPageAction(input));
