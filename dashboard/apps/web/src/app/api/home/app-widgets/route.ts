// What the Overview's app cards show, asked again while it is open. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { readAppWidgetsAction } from "@/app/(app)/home/app-widget-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => readAppWidgetsAction());
