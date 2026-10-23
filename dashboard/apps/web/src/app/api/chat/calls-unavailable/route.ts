// why calls are off, asked again on a timer. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { callsUnavailableAction } from "@/app/(app)/chat/meeting-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => callsUnavailableAction());
