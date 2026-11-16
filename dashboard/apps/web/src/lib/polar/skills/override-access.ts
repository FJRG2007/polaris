/**
 * Who may edit a skill for everybody on this Polaris: an administrator acting
 * as themselves. The settings page reads this to offer the choice and every
 * write checks it again, so the screen never offers what the server refuses.
 */

import type { SessionUser } from "@/lib/session";

export function canEditInstanceSkills(user: Pick<SessionUser, "isAdmin" | "viewingAs">): boolean {
    return user.isAdmin && !user.viewingAs;
}
