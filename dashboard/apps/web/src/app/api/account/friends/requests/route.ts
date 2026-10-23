// the friend requests waiting. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { loadFriendRequestsAction } from "@/app/(app)/account/privacy/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => loadFriendRequestsAction());
