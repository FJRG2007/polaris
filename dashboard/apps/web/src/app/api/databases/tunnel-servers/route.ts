// the servers a connection can tunnel through. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { listTunnelServersAction } from "@/app/(app)/apps/databases/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => listTunnelServersAction());
