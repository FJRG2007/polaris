// the NAS connections a volume can use. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { listNasConnectionsAction } from "@/app/(app)/apps/deploy/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => listNasConnectionsAction());
