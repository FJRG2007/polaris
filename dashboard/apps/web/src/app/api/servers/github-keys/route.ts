// the keys on the reader's linked GitHub accounts. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { githubKeysAction } from "@/app/(app)/apps/servers/ssh-key-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => githubKeysAction());
