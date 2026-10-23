// a screen's extra translations. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { listParam, pollRoute } from "@/lib/poll-route";
import { namespaceMessagesAction } from "@/components/i18n/namespace-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ names: listParam }),
    ({ names }) => namespaceMessagesAction(names),
    { signedIn: false }
);
