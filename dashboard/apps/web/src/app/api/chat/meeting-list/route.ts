// the meetings the account can see, asked again on a timer. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { listMeetingsAction } from "@/app/(app)/chat/meeting-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => listMeetingsAction());
