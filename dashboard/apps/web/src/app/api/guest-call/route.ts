// A call as a guest waiting at its door sees it, asked again until they are let in. The seat comes from the guest's cookie, as in the action, so no sign-in is asked for. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { readCallAction } from "@/app/(app)/chat/meeting-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ meetingId: z.string().trim().min(1).max(100) }),
    ({ meetingId }) => readCallAction(meetingId),
    { signedIn: false }
);
