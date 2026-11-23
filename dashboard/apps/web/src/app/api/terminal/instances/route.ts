/**
 * GET /api/terminal/instances - the Polaris Terminals a key's account can reach.
 *
 * What `polaris terminal list` prints for the terminals that are not on this
 * computer: the account's own and the ones shared with it, each with whether it
 * holds a relay socket right now. The same list the web screen shows
 * (`lib/terminal/instances.ts`), for any key that holds `terminal.control` -
 * the scope the relay asks of a controller, so a key that can read this list can
 * also act on what it names.
 */

import { requireApiKey } from "@/lib/api-key-auth";
import { listTerminals } from "@/lib/terminal/instances";
import { withKeyUsage } from "@/lib/api-usage/recorder";
import { TERMINAL_CONTROL_SCOPE } from "@/lib/terminal/relay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withKeyUsage(async (request: Request): Promise<Response> => {
    const principal = await requireApiKey(request, TERMINAL_CONTROL_SCOPE);
    if (principal instanceof Response) return principal;
    const { owned, shared } = await listTerminals(principal.userId);
    return Response.json({ terminals: [...owned, ...shared] }, { headers: { "cache-control": "no-store" } });
});
