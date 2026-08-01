"use server";

/**
 * Integrations admin actions. Configuring an integration stores an instance-wide
 * secret, so every action here is admin-gated. The API key is tri-state: a new
 * non-empty value replaces the stored one, an empty value keeps it. Enabling an
 * integration that needs a key with none on file is rejected up front.
 */

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { verifyIp } from "@/lib/integrations/dymo";
import { applyTunnel } from "@/lib/tunnel-service";
import { verifyKey } from "@/lib/integrations/virustotal";
import type { CfAccount } from "@/lib/integrations/cloudflare-api";
import { setDomainConfig, syncDuckDns } from "@/lib/domain-service";
import { isTunnelToken, tunnelTokenHint } from "@/lib/integrations/tunnel-token";
import { getIntegrationState, upsertIntegration } from "@/lib/integration-service";
import type { CloudflareTokenScope } from "@/lib/integrations/cloudflare-token-link";
import { DYMO_IP_RULES, findIntegration, type ScanAction } from "@/lib/integrations/registry";
import {
    connectCloudflareToken,
    disconnectCloudflareToken
} from "@/lib/integrations/cloudflare-account-service";
import {
    connectGithubApp,
    connectGithubPat,
    disconnectGithub,
    refreshInstallations,
    verifyGithubToken
} from "@/lib/github-service";

const SCAN_ACTIONS = new Set<ScanAction>(["block", "quarantine", "notify"]);

/**
 * Configure a tunnel provider (cloudflare/ngrok). Enabling one runs the tunnel
 * container; only one runs per server, so enabling a provider disables the other.
 * The token is tri-state (a value replaces it, blank keeps it).
 *
 * Every failure comes back as a message rather than a thrown action: the caller is
 * a dialog, and an action that rejects takes the whole page down with it.
 */
export async function saveTunnelAction(input: {
    provider: "cloudflare" | "ngrok";
    enabled: boolean;
    token?: string;
}): Promise<{ error?: string }> {
    // Outside the try - it redirects an unauthorized caller by throwing.
    const user = await requireAdmin();
    const provider = input.provider;
    if (provider !== "cloudflare" && provider !== "ngrok") return { error: "Unknown tunnel provider" };
    const newToken = input.token && input.token.trim() ? input.token.trim() : undefined;
    if (newToken && !isTunnelToken(provider, newToken)) return { error: tunnelTokenHint(provider) };

    try {
        const existing = await getIntegrationState(provider);
        const willHaveToken = Boolean(newToken) || Boolean(existing?.hasSecret);
        if (input.enabled && !willHaveToken) return { error: "Add the token before enabling it" };

        if (input.enabled) {
            // Only one tunnel per server - turn the other provider off.
            const other = provider === "cloudflare" ? "ngrok" : "cloudflare";
            await upsertIntegration(other, { enabled: false });
        }
        await upsertIntegration(provider, { enabled: input.enabled, secret: newToken, installedById: user.id });
        await recordAudit({
            actorId: user.id,
            action: "integration.configure",
            targetType: "integration",
            targetId: provider,
            metadata: { enabled: input.enabled }
        });
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "The tunnel settings could not be saved" };
    }

    // The settings are stored either way, so the page reflects them even when the
    // container refuses to come up and the dialog stays open on the reason.
    revalidatePath("/integrations");
    try {
        await applyTunnel();
    } catch (caught) {
        const detail = caught instanceof Error ? caught.message : "the tunnel could not start";
        return { error: `Saved, but the tunnel could not start: ${detail}` };
    }
    return {};
}

/**
 * Configure DuckDNS (subdomain + token). Stored with the domain settings, not an
 * Integration row, and reused by the auto-sync loop. The token is tri-state (a value
 * replaces it, blank keeps it); enabling requires both a subdomain and a token.
 */
export async function saveDuckdnsAction(input: {
    subdomain: string;
    token?: string;
}): Promise<{ error?: string }> {
    const user = await requireAdmin();
    const subdomain = input.subdomain.trim();
    if (!subdomain) return { error: "Enter your DuckDNS subdomain" };
    await setDomainConfig({ duckdnsSubdomain: subdomain, duckdnsToken: input.token });
    await recordAudit({
        actorId: user.id,
        action: "integration.configure",
        targetType: "integration",
        targetId: "duckdns"
    });
    // Push the record to the current IP right away so the subdomain resolves.
    await syncDuckDns().catch(() => undefined);
    revalidatePath("/integrations");
    return {};
}

/** Update the DuckDNS record to this server's current public IP (the dialog's Sync button). */
export async function syncDuckdnsAction(): Promise<{ ok: boolean; detail: string }> {
    await requireAdmin();
    return syncDuckDns();
}

/**
 * Connect a Cloudflare API token for `scope` - DNS records, named tunnels, or one
 * token carrying both. Validates it and, where an account is needed, resolves it;
 * when the token reaches several accounts and none is chosen, returns them so the UI
 * can prompt (nothing is stored until one is set). Also called from the domains
 * guided setup, which asks for a DNS token inline so the zone's records can be
 * created without a detour through this page.
 */
export async function connectCloudflareAccountAction(input: {
    token: string;
    scope?: CloudflareTokenScope;
    accountId?: string;
}): Promise<{
    error?: string;
    connected?: boolean;
    accounts?: CfAccount[];
    accountName?: string;
    stored?: CloudflareTokenScope[];
}> {
    const user = await requireAdmin();
    try {
        const scope = input.scope ?? "all";
        const result = await connectCloudflareToken(input.token, { scope, ...(input.accountId ? { accountId: input.accountId } : {}) });
        if (result.connected) {
            await recordAudit({
                actorId: user.id,
                action: "integration.configure",
                targetType: "integration",
                targetId: "cloudflare",
                // What the token was connected for, not the token: an audit row naming
                // the scope explains a later change, and never repeats a credential.
                metadata: { method: "api-token", scope, stored: result.stored.join(",") }
            });
            revalidatePath("/integrations");
        }
        return {
            connected: result.connected,
            accounts: result.accounts,
            accountName: result.accountName,
            stored: result.stored
        };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not connect the Cloudflare token" };
    }
}

/** Forget one connected Cloudflare token, or both. */
export async function disconnectCloudflareAccountAction(input?: {
    scope?: CloudflareTokenScope;
}): Promise<{ error?: string }> {
    const user = await requireAdmin();
    const scope = input?.scope ?? "all";
    await disconnectCloudflareToken(scope);
    await recordAudit({
        actorId: user.id,
        action: "integration.disable",
        targetType: "integration",
        targetId: "cloudflare",
        metadata: { scope }
    });
    revalidatePath("/integrations");
    return {};
}

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

/** Connect an existing GitHub App by App ID + private key (validated before storing). */
export async function connectGithubAppAction(input: {
    appId: string;
    pem: string;
    appName?: string;
    /** Optional, and only used so people can link their own GitHub account: the
     *  app can act on repositories without them. */
    clientId?: string;
    clientSecret?: string;
}): Promise<{ error?: string; installations?: number }> {
    const user = await requireAdmin();
    try {
        const { installations } = await connectGithubApp(input);
        await recordAudit({ actorId: user.id, action: "integration.configure", targetType: "integration", targetId: "github", metadata: { method: "app" } });
        revalidatePath("/integrations");
        return { installations };
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not connect the GitHub App" };
    }
}

/** Refresh the stored list of app installations (after installing on more accounts). */
export async function refreshGithubInstallationsAction(): Promise<{ error?: string }> {
    await requireAdmin();
    try {
        await refreshInstallations();
        revalidatePath("/integrations");
        return {};
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "Could not refresh installations" };
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
