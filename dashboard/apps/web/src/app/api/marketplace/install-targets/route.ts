// the machines an app can be installed on. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { listInstallTargetsAction } from "@/app/(app)/apps/marketplace/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => listInstallTargetsAction());
