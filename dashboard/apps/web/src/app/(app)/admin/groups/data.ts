"use server";

import type { GroupRow } from "./groups-admin";
import { readGroupsAdmin } from "./read";
import { requireAdmin } from "@/lib/session";

/** The groups again, for a retry or a refresh after a change. The first visit's
 *  answer arrives with the page (`read.ts`). */
export async function loadGroupsAdminAction(): Promise<GroupRow[]> {
    await requireAdmin();
    return readGroupsAdmin();
}
