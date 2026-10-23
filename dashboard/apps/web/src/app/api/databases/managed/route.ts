// the databases Polaris runs that a connection can point at. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { listManagedAction } from "@/app/(app)/apps/databases/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => listManagedAction());
