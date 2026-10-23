// the storage an app's volumes can live on. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { listStorageConnectionsAction } from "@/app/(app)/apps/marketplace/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => listStorageConnectionsAction());
