// Telemetry: the releases a project's events name. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { jsonParam, pollRoute } from "@/lib/poll-route";
import { releasesAction } from "@/app/(app)/telemetry/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The action parses the input with its own schema.
export const GET = pollRoute(z.object({ input: jsonParam }), ({ input }) => releasesAction(input));
