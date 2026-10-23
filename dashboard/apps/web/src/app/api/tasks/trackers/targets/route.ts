// the spaces and lists a tracker can file into. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { trackerTargetsAction } from "@/app/(app)/tasks/trackers/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => trackerTargetsAction());
