"use server";

/**
 * Diagnostics actions: the fixes a finding offers, and the speed test.
 * Admin-only, and every input validated here rather than trusted from the page.
 */

import { requireAdmin } from "@/lib/session";
import { syncAppRoutes } from "@/lib/deploy-service";
import { getCapabilities } from "@polaris/config";
import { reclaimHostSpace } from "@/lib/deploy/host-space";
import { runSpeedTest, type SpeedTestOutcome } from "@/lib/diagnostics/speed-test";
import {
    fixActionSchema,
    runCheck,
    type CheckId,
    type CheckResult
} from "@/lib/diagnostics/checks";

const CHECK_FOR: Record<"republishRoutes" | "freeSpace", CheckId> = {
    republishRoutes: "edge",
    freeSpace: "disk"
};

/**
 * Run a fix, then the check it answers, so the row shows the outcome rather
 * than the hope. `ok: false` is a fix that could not run here at all.
 */
export async function runFixAction(input: unknown): Promise<{ ok: boolean; check?: CheckResult }> {
    await requireAdmin();
    const parsed = fixActionSchema.safeParse(input);
    if (!parsed.success) return { ok: false };
    try {
        if (parsed.data === "republishRoutes") await syncAppRoutes();
        else {
            if (getCapabilities().edition !== "full") return { ok: false };
            if ((await reclaimHostSpace({ whenIdle: true })) === null)
                return { ok: false, check: await runCheck(CHECK_FOR[parsed.data]) };
        }
    } catch (error) {
        console.error(`polaris: diagnostics fix ${parsed.data} failed:`, error);
        return { ok: false, check: await runCheck(CHECK_FOR[parsed.data]) };
    }
    return { ok: true, check: await runCheck(CHECK_FOR[parsed.data]) };
}

export async function runSpeedTestAction(): Promise<SpeedTestOutcome> {
    await requireAdmin();
    return runSpeedTest();
}
