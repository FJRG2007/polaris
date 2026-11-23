"use server";

import { requireAdmin } from "@/lib/session";
import { ownCodeCheck, type SelfCheck } from "@/lib/integrity/self-check";

/** Whether this server runs the code Polaris built (lib/integrity/self-check).
 *  `fresh` checks again instead of answering the last result. */
export async function ownCodeCheckAction(fresh = false): Promise<SelfCheck> {
    await requireAdmin();
    return ownCodeCheck(fresh === true);
}
