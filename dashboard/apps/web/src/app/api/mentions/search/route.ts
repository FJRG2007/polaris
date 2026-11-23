// What the @ and # pickers ask for. A route, not an action: a tab's server
// actions run one at a time, and typing "@" also sends the typing ping, so the
// search waited behind it and the picker showed only the room words until the
// answer finally came. See lib/poll-route.
import { z } from "zod";
import { actionRoute } from "@/lib/poll-route";
import { searchMentionsAction } from "@/app/(app)/mention-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The action validates kinds, query and conversation (`searchInput`).
export const POST = actionRoute(z.object({}).passthrough(), (input) => searchMentionsAction(input));
