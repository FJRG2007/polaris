// the transfers waiting for the account. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { waitingTransfersAction } from "@/app/(app)/drive/transfer-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => waitingTransfersAction());
