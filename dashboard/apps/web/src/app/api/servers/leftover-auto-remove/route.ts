// whether deleted apps' data is removed on its own. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { leftoverAutoRemoveAction } from "@/app/(app)/apps/servers/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => leftoverAutoRemoveAction());
