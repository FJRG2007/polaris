"use server";

/**
 * The privacy settings again, for a retry or a refresh after a change. The
 * first visit's answer arrives with the page (`read.ts`).
 */

import { requireAdmin } from "@/lib/session";
import { readPrivacy, type PrivacyData } from "./read";

export async function loadPrivacyAction(): Promise<PrivacyData> {
    await requireAdmin();
    return readPrivacy();
}
