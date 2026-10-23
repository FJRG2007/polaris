// the machines a mail server can run on. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { listPlacementsAction } from "@/app/(app)/apps/mail-server/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => listPlacementsAction());
