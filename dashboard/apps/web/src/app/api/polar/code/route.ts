// Polar's Code side: access and the session list, asked again on a timer. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { polarCodeAction } from "@/app/(app)/polar/code-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => polarCodeAction());
