// what an app widget on the overview can show. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { appWidgetTargetsAction } from "@/app/(app)/home/app-widget-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(
    z.object({ app: z.string().trim().min(1).max(200), kind: z.string().trim().min(1).max(200) }),
    ({ app, kind }) => appWidgetTargetsAction(app, kind)
);
