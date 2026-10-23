// the services Analytics can measure. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { listAnalyticsSitesAction } from "@/app/(app)/apps/analytics/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => listAnalyticsSitesAction());
