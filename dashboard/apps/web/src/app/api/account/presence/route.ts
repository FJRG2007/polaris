// one's own presence, asked again when the menu opens. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { presenceNowAction } from "@/app/(app)/account/preferences/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => presenceNowAction());
