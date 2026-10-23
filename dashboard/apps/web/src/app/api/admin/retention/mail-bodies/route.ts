// how many mail bodies are held. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { mailBodyHeldAction } from "@/app/(app)/admin/retention/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => mailBodyHeldAction());
