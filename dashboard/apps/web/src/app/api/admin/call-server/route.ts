// the call server's settings, asked again while it starts. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { callServerSettingsAction } from "@/app/(app)/admin/chat/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => callServerSettingsAction());
