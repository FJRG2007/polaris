"use server";

import { requireAdmin } from "@/lib/session";
import { lastSpeedResult } from "@/lib/diagnostics/speed-test";

/** The last speed test, shown until a new one is run. */
export async function loadDiagnosticsAction() {
    await requireAdmin();
    return { speed: await lastSpeedResult() };
}
