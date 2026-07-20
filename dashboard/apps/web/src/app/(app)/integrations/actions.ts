"use server";

/**
 * Integrations admin actions. Configuring an integration stores an instance-wide
 * secret, so every action here is admin-gated. The API key is tri-state: a new
 * non-empty value replaces the stored one, an empty value keeps it. Enabling an
 * integration that needs a key with none on file is rejected up front.
 */

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { DYMO_IP_RULES, findIntegration, type ScanAction } from "@/lib/integrations/registry";
import { getIntegrationState, upsertIntegration } from "@/lib/integration-service";
import { verifyKey } from "@/lib/integrations/virustotal";
import { verifyIp } from "@/lib/integrations/dymo";
import { connectGithubPat, disconnectGithub, verifyGithubToken } from "@/lib/github-service";
import { recordAudit } from "@/lib/audit-service";

const SCAN_ACTIONS = new Set<ScanAction>(["block", "quarantine", "notify"]);

/** Save VirusTotal's settings (enabled flag, detection action, and API key). */
export async function saveVirusTotalAction(input: {
    enabled: boolean;
    scanDropPoints: boolean;
    onDetection: string;
    apiKey?: string;
}): Promise<{ error?: string }> {
    const user = await requireAdmin();
    const provider = "virustotal";
    const onDetection: ScanAction = SCAN_ACTIONS.has(input.onDetection as ScanAction)
        ? (input.onDetection as ScanAction)
        : "block";

    const existing = await getIntegrationState(provider);
    const newKey = input.apiKey && input.apiKey.trim() ? input.apiKey.trim() : undefined;
    const willHaveKey = Boolean(newKey) || Boolean(existing?.hasSecret);
    if (input.enabled && !willHaveKey) return { error: "Add a VirusTotal API key before enabling it" };

    // Validate a newly supplied key so a typo does not silently disable scanning.
    if (newKey) {
        const check = await verifyKey(newKey);
        if (!check.ok) return { error: check.error ?? "The API key was rejected" };
    }

    await upsertIntegration(provider, {
        enabled: input.enabled,
        config: { scanDropPoints: input.scanDropPoints, onDetection },
        secret: newKey,
        installedById: user.id
    });
    await recordAudit({
        actorId: user.id,
        action: "integration.configure",
        targetType: "integration",
        targetId: provider,
        metadata: { enabled: input.enabled, onDetection }
    });
    revalidatePath("/integrations");
    return {};
}

/** Verify a Dymo key by making one benign IP check; a bad key throws. */
async function testDymoKey(apiKey: string): Promise<{ ok: boolean; error?: string }> {
    try {
        await verifyIp(apiKey, "8.8.8.8", ["FRAUD"]);
        return { ok: true };
    } catch (caught) {
        return { ok: false, error: caught instanceof Error ? caught.message : "The API key was rejected" };
    }
}

/** Save Dymo's settings (enabled flag, IP-verify toggle, deny rules, and API key). */
export async function saveDymoAction(input: {
    enabled: boolean;
    verifyAccessIp: boolean;
    deny: string[];
    apiKey?: string;
}): Promise<{ error?: string }> {
    const user = await requireAdmin();
    const provider = "dymo";
    const existing = await getIntegrationState(provider);
    const newKey = input.apiKey && input.apiKey.trim() ? input.apiKey.trim() : undefined;
    const willHaveKey = Boolean(newKey) || Boolean(existing?.hasSecret);
    if (input.enabled && !willHaveKey) return { error: "Add a Dymo API key before enabling it" };

    const known = new Set(DYMO_IP_RULES.map((rule) => rule.value));
    const deny = input.deny.filter((value) => known.has(value));

    if (newKey) {
        const check = await testDymoKey(newKey);
        if (!check.ok) return { error: check.error ?? "The API key was rejected" };
    }

    await upsertIntegration(provider, {
        enabled: input.enabled,
        config: { verifyAccessIp: input.verifyAccessIp, deny: deny.length > 0 ? deny : ["FRAUD"] },
        secret: newKey,
        installedById: user.id
    });
    await recordAudit({
        actorId: user.id,
        action: "integration.configure",
        targetType: "integration",
        targetId: provider,
        metadata: { enabled: input.enabled }
    });
    revalidatePath("/integrations");
    return {};
}

/** Verify a Dymo API key without saving it (the configure dialog's Test button). */
export async function testDymoKeyAction(apiKey: string): Promise<{ ok: boolean; error?: string }> {
    await requireAdmin();
    if (!apiKey.trim()) return { ok: false, error: "Enter an API key first" };
    return testDymoKey(apiKey.trim());
}

/** Turn an integration off without forgetting its configuration. */
export async function setIntegrationEnabledAction(provider: string, enabled: boolean): Promise<{ error?: string }> {
    const user = await requireAdmin();
    if (!findIntegration(provider)) return { error: "Unknown integration" };
    if (enabled) {
        const state = await getIntegrationState(provider);
        if (!state?.hasSecret) return { error: "Configure the integration before enabling it" };
    }
    await upsertIntegration(provider, { enabled });
    await recordAudit({
        actorId: user.id,
        action: enabled ? "integration.enable" : "integration.disable",
        targetType: "integration",
        targetId: provider
    });
    revalidatePath("/integrations");
    return {};
}

/** Verify an API key without saving it (the configure dialog's Test button). */
export async function testVirusTotalKeyAction(apiKey: string): Promise<{ ok: boolean; error?: string }> {
    await requireAdmin();
    if (!apiKey.trim()) return { ok: false, error: "Enter an API key first" };
    return verifyKey(apiKey.trim());
}

/** Validate a GitHub token without saving it (the connect dialog's Test button). */
export async function testGithubTokenAction(token: string): Promise<{ ok: boolean; login?: string; error?: string }> {
    await requireAdmin();
    if (!token.trim()) return { ok: false, error: "Enter a token first" };
    try {
        const { login } = await verifyGithubToken(token.trim());
        return { ok: true, login };
    } catch (caught) {
        return { ok: false, error: caught instanceof Error ? caught.message : "The token was rejected" };
    }
}

/** Connect GitHub with a Personal Access Token (validated before it is stored). */
export async function connectGithubAction(token: string): Promise<{ error?: string; login?: string }> {
    const user = await requireAdmin();
    try {
        const { login } = await connectGithubPat(token, user.id);
        await recordAudit({ actorId: user.id, action: "integration.configure", targetType: "integration", targetId: "github", metadata: { login } });
        revalidatePath("/integrations");
        return { login };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not connect GitHub" };
    }
}

/** Disconnect GitHub and forget its token. */
export async function disconnectGithubAction(): Promise<{ error?: string }> {
    const user = await requireAdmin();
    await disconnectGithub();
    await recordAudit({ actorId: user.id, action: "integration.disable", targetType: "integration", targetId: "github" });
    revalidatePath("/integrations");
    return {};
}
