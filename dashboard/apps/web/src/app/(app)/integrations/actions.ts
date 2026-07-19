"use server";

/**
 * Integrations server actions. Every action re-checks the session and requires
 * `integrations.manage`, so the marketplace UI can never be driven by a user
 * without that permission. Secrets (API keys) are written straight into the
 * encrypted integration store and are never read back to the client.
 */

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/session";
import { getIntegrationState, saveIntegration, type IntegrationState } from "@/lib/integration-service";
import { verifyVirusTotalKey } from "@/lib/integrations/virustotal";
import { recordAudit } from "@/lib/audit-service";

/** Save the VirusTotal integration. An empty apiKey keeps the stored one. */
export async function saveVirusTotalAction(input: {
    enabled: boolean;
    apiKey?: string;
    scanDropPoints: boolean;
}): Promise<{ error?: string }> {
    const user = await requirePermission("integrations.manage");

    const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    const current = await getIntegrationState("virustotal");

    // Enabling requires a key: either a freshly entered one or a previously stored one.
    if (input.enabled && !apiKey && !current.hasCredential) {
        return { error: "Enter a VirusTotal API key to enable the integration." };
    }
    // Validate a newly entered key before saving, so a typo is caught immediately.
    if (apiKey) {
        const problem = await verifyVirusTotalKey(apiKey);
        if (problem) return { error: problem };
    }

    await saveIntegration({
        provider: "virustotal",
        enabled: input.enabled,
        config: { scanDropPoints: input.scanDropPoints },
        // undefined -> keep the stored key; a non-empty string -> replace it.
        credential: apiKey ? apiKey : undefined
    });

    await recordAudit({
        actorId: user.id,
        action: "integration.save",
        targetType: "integration",
        targetId: "virustotal",
        metadata: { enabled: input.enabled, scanDropPoints: input.scanDropPoints }
    });
    revalidatePath("/integrations");
    return {};
}

/** Read every integration's public state for the marketplace (no secrets). */
export async function loadIntegrationStatesAction(): Promise<IntegrationState[]> {
    await requirePermission("integrations.manage");
    return Promise.all([getIntegrationState("virustotal")]);
}
