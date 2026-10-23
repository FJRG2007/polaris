// whether Google import is available, and with which accounts. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { officeGoogleStateAction } from "@/app/(app)/office/google-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => officeGoogleStateAction());
