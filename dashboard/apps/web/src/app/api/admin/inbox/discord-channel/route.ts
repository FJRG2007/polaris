// the Discord bot channel to ask about servers. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { firstDiscordChannelAction } from "@/app/(app)/admin/inbox/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => firstDiscordChannelAction());
