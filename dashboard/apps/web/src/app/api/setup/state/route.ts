// whether the first-run setup is still to do. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { setupStateAction } from "@/app/(app)/setup-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => setupStateAction(), { signedIn: false });
