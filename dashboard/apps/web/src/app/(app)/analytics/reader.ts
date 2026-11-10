/**
 * Who gets into Analytics, kept out of the action module so it is not itself
 * an action a browser could call.
 */

import { grantedSubjects } from "@/lib/access/grants";
import { requirePermission, requireUser, sessionCan, type SessionUser } from "@/lib/session";

/**
 * Who may read Analytics: whoever runs services, or somebody a service's site
 * was shared with, who reads only those. Anybody else is turned away as before.
 */
export async function requireAnalyticsReader(): Promise<{
    user: SessionUser;
    /** The services shared with a reader who does not run services; null for one who does. */
    lent: ReadonlySet<string> | null;
}> {
    const user = await requireUser();
    if (await sessionCan(user, "deploy.manage")) return { user, lent: null };
    const held = await grantedSubjects(user.id, "analytics.site");
    if (held.size === 0) await requirePermission("deploy.manage");
    return { user, lent: new Set(held.keys()) };
}
