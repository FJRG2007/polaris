// the backup keys, without their recovery keys. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { listBackupKeysAction } from "@/app/(app)/apps/backups/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => listBackupKeysAction());
