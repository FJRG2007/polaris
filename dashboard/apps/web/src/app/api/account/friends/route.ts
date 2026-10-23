// a page of the account's friends. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { jsonParam, pollRoute } from "@/lib/poll-route";
import { loadFriendsAction } from "@/app/(app)/account/privacy/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({ after: jsonParam }), ({ after }) =>
    loadFriendsAction(after)
);
