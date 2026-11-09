// An answer to an agent's permission prompt, pressed on a notification. A route,
// not an action: the service worker has no action id to call. See lib/poll-route.
import { actionRoute } from "@/lib/poll-route";
import { permissionAnswerSchema } from "@/lib/agents/session-permissions";
import { answerPermissionAction } from "@/app/(app)/apps/agents/sessions/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = actionRoute(permissionAnswerSchema, (input) => answerPermissionAction(input));
