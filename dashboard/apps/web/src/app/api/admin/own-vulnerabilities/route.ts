// what the last scans found in Polaris's own images. A route, not an action: see lib/poll-route.
import { z } from "zod";
import { pollRoute } from "@/lib/poll-route";
import { ownVulnerabilitiesAction } from "@/app/(app)/admin/settings/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = pollRoute(z.object({}), () => ownVulnerabilitiesAction());
