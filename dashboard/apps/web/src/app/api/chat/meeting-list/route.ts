// the meetings the account can see, asked again on a timer. A route, not an action: see lib/poll-route.
import { pollRoute } from "@/lib/poll-route";
import { meetingListQuerySchema } from "@/lib/chat/meeting-list";
import { listMeetingsAction } from "@/app/(app)/chat/meeting-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(meetingListQuerySchema, (query) => listMeetingsAction(query));
