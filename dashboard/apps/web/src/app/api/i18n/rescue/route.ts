// The messages a production screen was not handed, and a log of what it missed
// (BUG-0037). A route, not an action: see lib/poll-route.
import { z } from "zod";
import { listParam, pollRoute } from "@/lib/poll-route";
import { rescueMessagesAction } from "@/components/i18n/namespace-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ names: listParam, keys: listParam }),
    ({ names, keys }) => rescueMessagesAction(names, keys),
    { signedIn: false }
);
