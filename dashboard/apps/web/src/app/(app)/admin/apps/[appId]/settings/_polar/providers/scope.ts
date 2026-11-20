/**
 * Who the deployment's AI providers screen writes for: the deployment's own
 * keys, written by whichever administrator is signed in.
 */

import { requireAdmin } from "@/lib/session";
import { INSTANCE } from "@/lib/agents/model-keys";
import type { KeyScope } from "@/lib/agents/model-key-actions";

export async function instanceScope(): Promise<KeyScope> {
    const admin = await requireAdmin();
    return { owner: INSTANCE, actorId: admin.id, path: "/admin/apps/polar/settings/providers", audit: "instance" };
}
