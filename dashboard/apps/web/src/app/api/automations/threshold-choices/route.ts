// what a threshold trigger can watch. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { thresholdChoicesAction } from "@/app/(app)/automations/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => thresholdChoicesAction());
