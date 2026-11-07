"use server";

import { requireAdmin } from "@/lib/session";
import { instanceTag } from "@/lib/name-tags/name-tag-service";

/** The instance's name tag, asked for after the badges screen has painted. */
export async function loadInstanceTagAction() {
    await requireAdmin();
    return instanceTag();
}
