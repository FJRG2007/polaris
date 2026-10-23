// the apps the first-run setup installed. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { setupInstalledAction } from "@/app/(app)/setup-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => setupInstalledAction(), { signedIn: false });
