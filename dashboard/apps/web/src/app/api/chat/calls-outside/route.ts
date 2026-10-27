// whether callers outside the house can reach a call, asked again on a timer. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { callsOutsideAction } from "@/app/(app)/chat/meeting-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => callsOutsideAction());
