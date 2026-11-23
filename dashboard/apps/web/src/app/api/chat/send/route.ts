// Sending a message. A route, not an action: a tab's server actions run one at
// a time, behind its navigations, so a send went out only after whatever the
// screen had asked before it - a typing ping, a read mark, a refresh - and the
// message sat on its clock for all of it. See lib/poll-route.
import { z } from "zod";
import { actionRoute } from "@/lib/poll-route";
import { sendAction } from "@/app/(app)/chat/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The action validates the message itself (`chatSendSchema`); this only
// refuses a body that is not an object before it gets there.
export const POST = actionRoute(z.object({}).passthrough(), (input) => sendAction(input));
