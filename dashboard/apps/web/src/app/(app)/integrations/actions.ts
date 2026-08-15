"use server";

/**
 * Integrations admin actions. Configuring an integration stores an instance-wide
 * secret, so every action here is admin-gated. The API key is tri-state: a new
 * non-empty value replaces the stored one, an empty value keeps it. Enabling an
 * integration that needs a key with none on file is rejected up front.
 */

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { setSetting } from "@/lib/setting-store";
import { recordAudit } from "@/lib/audit-service";
import { verifyIp } from "@/lib/integrations/dymo";
import { applyTunnel } from "@/lib/tunnel-service";
import { STEAM_PROVIDER } from "@/lib/connections/steam";
import { verifyKey } from "@/lib/integrations/virustotal";
import { GATEWAY_SLUG } from "@/lib/agents/agent-providers";
import { CRIMINALIP_RULES } from "@/lib/integrations/criminalip";
import type { CfAccount } from "@/lib/integrations/cloudflare-api";
import { setDomainConfig, syncDuckDns } from "@/lib/domain-service";
import { isTunnelToken, tunnelTokenHint } from "@/lib/integrations/tunnel-token";
import type { CloudflareTokenScope } from "@/lib/integrations/cloudflare-token-link";
import { connectionRedirectUri, verifyConnectionOAuthApp } from "@/lib/connections/oauth";
import { DYMO_IP_RULES, findIntegration, type ScanAction } from "@/lib/integrations/registry";
import { connectGithubApp, disconnectGithub, refreshInstallations } from "@/lib/github-service";
import { getIntegrationSecret, getIntegrationState, upsertIntegration } from "@/lib/integration-service";
import {
    connectCloudflareToken,
    disconnectCloudflareToken
} from "@/lib/integrations/cloudflare-account-service";
import {
    connectionEmailTrustKey,
    connectionLimitKey,
    connectionSignInKey,
    findConnectionProvider
} from "@polaris/core";

const SCAN_ACTIONS = new Set<ScanAction>(["block", "quarantine", "notify"]);

/** Nobody needs more than this, and an unbounded number is a way to make one
 *  account hold a hundred credentials. */
const MAX_ACCOUNTS_PER_USER = 20;

/**
 * How many accounts of one service a person may connect. One by default, which
 * covers everybody with a single GitHub or Google account; raised for a
 * deployment where people keep work and personal accounts apart, and set to zero
 * to turn connecting that service off without disconnecting the application.
 *
 * Lowering it never removes anything already linked - the people over the new
 * limit simply cannot add another - because silently disconnecting somebody's
 * account would stop their deployments with no warning.
 */
export async function saveConnectionLimitAction(provider: string, limit: number): Promise<{ error?: string }> {
    const user = await requireAdmin();
    if (!findConnectionProvider(provider)) return { error: "Unknown service" };
    if (!Number.isInteger(limit) || limit < 0 || limit > MAX_ACCOUNTS_PER_USER) {
        return { error: `Choose a number between 0 and ${MAX_ACCOUNTS_PER_USER}` };
    }

    await setSetting(connectionLimitKey(provider), String(limit));
    await recordAudit({
        actorId: user.id,
        action: "integration.configure",
        targetType: "integration",
        targetId: provider,
        metadata: { accountsPerUser: limit }
    });
    revalidatePath("/integrations");
    revalidatePath("/account/connections");
    return {};
}

/**
 * Whether a connected account of this service may sign its owner in here.
 *
 * The operator's half of the decision; each person still chooses for their own
 * account, and both have to allow it. Turning it off leaves every link in place
 * and only closes the door, so a service can be refused as a way in without
 * anybody losing the repositories or the calendar it was linked for.
 */
export async function saveConnectionSignInAction(provider: string, allowed: boolean): Promise<{ error?: string }> {
    const user = await requireAdmin();
    if (!findConnectionProvider(provider)) return { error: "Unknown service" };

    await setSetting(connectionSignInKey(provider), allowed === true ? "true" : "false");
    await recordAudit({
        actorId: user.id,
        action: "integration.configure",
        targetType: "integration",
        targetId: provider,
        metadata: { signIn: allowed === true }
    });
    revalidatePath("/integrations");
    revalidatePath("/account/security");
    return {};
}

/**
 * Whether this service's word confirms the address it hands over.
 *
 * Only offered for the services that hand one over at all. Turning it off does
 * not release any address already held, and does not un-confirm one already
 * confirmed: what was proved was proved, and taking it back would ask people to
 * re-prove an address on the strength of a switch they never saw.
 */
export async function saveConnectionEmailTrustAction(
    provider: string,
    trusted: boolean
): Promise<{ error?: string }> {
    const user = await requireAdmin();
    const entry = findConnectionProvider(provider);
    if (!entry) return { error: "Unknown service" };
    if (entry.emailTrustDefault === undefined) return { error: `${entry.name} does not hand over an address.` };

    await setSetting(connectionEmailTrustKey(provider), trusted === true ? "true" : "false");
    await recordAudit({
        actorId: user.id,
        action: "integration.configure",
        targetType: "integration",
        targetId: provider,
        metadata: { emailTrust: trusted === true }
    });
    revalidatePath("/integrations");
    return {};
}

/**
 * Connect the Google Cloud OAuth client people authorize their own calendars
 * against. The client id is not a secret and lives in the config; the client
 * secret is stored encrypted and is tri-state, so an operator can flip the
 * switch without re-typing it.
 *
 * Enabling it with no secret on file is refused here rather than at the first
 * link attempt, where the person hitting the error would be somebody who cannot
 * fix it.
 */
/**
 * Register the operator's OAuth application for one of the services people link
 * a personal account of.
 *
 * One action for all of them because the shape is identical - a client id, a
 * secret, and whether it is on. The slug is checked against the catalog rather
 * than trusted, so this cannot be used to write an Integration row for something
 * that is not an OAuth app.
 *
 * Switching one on is what puts a Connect button in front of everybody here, so
 * the provider is asked first whether it would accept the application at all.
 * Half a setup - a secret from another client, a redirect URI never pasted into
 * the console - looks exactly like a working one from this screen, and the person
 * who finds out is somebody who cannot fix it.
 */
export async function saveOAuthAppAction(input: {
    slug: string;
    enabled: boolean;
    clientId: string;
    clientSecret?: string;
}): Promise<{ error?: string }> {
    const user = await requireAdmin();
    const slug = input.slug;
    if (!["google", "microsoft", "dropbox", "epic", "minecraft"].includes(slug)) {
        return { error: "That integration does not take an OAuth application" };
    }
    const clientId = input.clientId.trim();
    const clientSecret = input.clientSecret?.trim() ? input.clientSecret.trim() : undefined;

    try {
        const existing = await getIntegrationState(slug);
        if (input.enabled && !clientId) return { error: "Add the client ID before enabling it" };
        if (input.enabled && !clientSecret && !existing?.hasSecret) {
            return { error: "Add the client secret before enabling it" };
        }
        if (input.enabled) {
            // The stored one when the field was left blank, which is how an
            // operator flips the switch without re-typing a secret.
            const secret = clientSecret ?? (await getIntegrationSecret(slug));
            const refused = secret
                ? await verifyConnectionOAuthApp(
                      slug,
                      { clientId, clientSecret: secret },
                      await connectionRedirectUri(slug)
                  )
                : null;
            if (refused) return { error: refused };
        }
        await upsertIntegration(slug, {
            enabled: input.enabled,
            config: { ...existing?.config, clientId },
            secret: clientSecret,
            installedById: user.id
        });
        await recordAudit({
            actorId: user.id,
            action: "integration.configure",
            targetType: "integration",
            targetId: slug,
            metadata: { enabled: input.enabled }
        });
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "The application could not be saved" };
    }

    revalidatePath("/integrations");
    revalidatePath("/account/connections");
    return {};
}

/**
 * Switch Steam on, and hold the optional Web API key.
 *
 * Its own action because Steam is the one service here with nothing to register:
 * it proves an account over OpenID, so there is no client id and no secret to
 * refuse to enable without. The key buys the name and avatar beside a linked
 * account and nothing else, which is why enabling with none is a valid state
 * rather than a half-configured one.
 *
 * Tri-state on the key, like every other secret on this screen: a value replaces
 * it, blank keeps what is stored.
 */
export async function saveSteamAction(input: { enabled: boolean; apiKey?: string }): Promise<{ error?: string }> {
    const user = await requireAdmin();
    const apiKey = input.apiKey?.trim() ? input.apiKey.trim() : undefined;
    try {
        const existing = await getIntegrationState(STEAM_PROVIDER);
        await upsertIntegration(STEAM_PROVIDER, {
            enabled: input.enabled,
            config: { ...existing?.config },
            secret: apiKey,
            installedById: user.id
        });
        await recordAudit({
            actorId: user.id,
            action: "integration.configure",
            targetType: "integration",
            targetId: STEAM_PROVIDER,
            metadata: { enabled: input.enabled }
        });
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "The Steam settings could not be saved" };
    }

    revalidatePath("/integrations");
    return {};
}

/**
 * Point calls at a licensed noise filter.
 *
 * The address is checked here rather than trusted: it is loaded as code by every
 * browser in a call, so an http address on a page served over https would be
 * blocked by the browser anyway, and anything that is not a URL at all would
 * fail silently in a call somebody is already in.
 */
export async function saveLicensedFilterAction(input: {
    enabled: boolean;
    moduleUrl: string;
    token?: string;
}): Promise<{ error?: string }> {
    const user = await requireAdmin();
    const moduleUrl = input.moduleUrl.trim();

    if (input.enabled) {
        let parsed: URL;
        try {
            parsed = new URL(moduleUrl);
        } catch {
            return { error: "That is not an address" };
        }
        if (parsed.protocol !== "https:") return { error: "The address has to be https" };
    }

    try {
        await upsertIntegration("krisp", {
            enabled: input.enabled,
            config: { moduleUrl },
            secret: input.token?.trim() ? input.token.trim() : undefined,
            installedById: user.id
        });
        await recordAudit({
            actorId: user.id,
            action: "integration.configure",
            targetType: "integration",
            targetId: "krisp",
            metadata: { enabled: input.enabled }
        });
    } catch (caught) {
        return {
            error: caught instanceof Error ? caught.message : "That could not be saved"
        };
    }

    revalidatePath("/integrations");
    return {};
}

/**
 * Turn the GIF and sticker search on, with the key it runs on.
 *
 * Nothing else in Polaris changes when this is off: the picker still offers
 * emoji, what each person has kept, and anything sent by its address. This is
 * one tab in one popover, which is why it is a key and a switch and no settings.
 */
export async function saveTenorAction(input: {
    enabled: boolean;
    apiKey?: string;
}): Promise<{ error?: string }> {
    const user = await requireAdmin();
    const apiKey = input.apiKey?.trim() ? input.apiKey.trim() : undefined;
    try {
        const existing = await getIntegrationState("tenor");
        if (input.enabled && !apiKey && !existing?.hasSecret) {
            return { error: "Add the API key before turning it on" };
        }
        await upsertIntegration("tenor", {
            enabled: input.enabled,
            secret: apiKey,
            installedById: user.id
        });
        await recordAudit({
            actorId: user.id,
            action: "integration.configure",
            targetType: "integration",
            targetId: "tenor",
            metadata: { enabled: input.enabled }
        });
    } catch (caught) {
        return {
            error: caught instanceof Error ? caught.message : "That could not be saved"
        };
    }

    revalidatePath("/integrations");
    return {};
}

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

/**
 * Save Criminal IP's settings (enabled flag, the verdicts that block, and the key).
 *
 * The key is not test-called first, unlike Dymo's: their summary endpoint spends a
 * lookup from the operator's own quota, and the firewall already treats a provider
 * error as "not blocking", so a wrong key costs nothing but a log line.
 */
export async function saveCriminalIpAction(input: {
    enabled: boolean;
    deny: string[];
    apiKey?: string;
}): Promise<{ error?: string }> {
    const user = await requireAdmin();
    const provider = "criminalip";
    const newKey = input.apiKey?.trim() ? input.apiKey.trim() : undefined;

    try {
        const existing = await getIntegrationState(provider);
        if (input.enabled && !newKey && !existing?.hasSecret) {
            return { error: "Add a Criminal IP API key before enabling it" };
        }

        const known = new Set<string>(CRIMINALIP_RULES.map((rule) => rule.value));
        const deny = input.deny.filter((value) => known.has(value));
        if (input.enabled && deny.length === 0) return { error: "Pick at least one verdict to block on" };

        await upsertIntegration(provider, {
            enabled: input.enabled,
            config: { ...existing?.config, deny },
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
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "The Criminal IP settings could not be saved" };
    }

    revalidatePath("/integrations");
    return {};
}

/** Verify a Dymo API key without saving it (the configure dialog's Test button). */
export async function testDymoKeyAction(apiKey: string): Promise<{ ok: boolean; error?: string }> {
    await requireAdmin();
    if (!apiKey.trim()) return { ok: false, error: "Enter an API key first" };
    return testDymoKey(apiKey.trim());
}

/**
 * Connect a model provider - one of the operator's own provider accounts, stored
 * as a key and handed to a run over its authenticated call.
 *
 * Nothing is verified against the provider: a request that proves a key works
 * costs tokens on somebody's account, and these keys fail loudly at the start of
 * a run naming themselves. The key is tri-state as everywhere else here, so the
 * switch can be flipped without re-typing it.
 */
export async function saveModelProviderAction(input: {
    slug: string;
    enabled: boolean;
    apiKey?: string;
}): Promise<{ error?: string }> {
    const user = await requireAdmin();
    const entry = findIntegration(input.slug);
    if (!entry || entry.category !== "Models" || entry.slug === GATEWAY_SLUG) return { error: "Unknown model provider" };

    try {
        const existing = await getIntegrationState(entry.slug);
        const newKey = input.apiKey?.trim() ? input.apiKey.trim() : undefined;
        if (input.enabled && !newKey && !existing?.hasSecret) return { error: "Add the API key before enabling it" };

        await upsertIntegration(entry.slug, {
            enabled: input.enabled,
            secret: newKey,
            installedById: user.id
        });
        await recordAudit({
            actorId: user.id,
            action: "integration.configure",
            targetType: "integration",
            targetId: entry.slug,
            metadata: { enabled: input.enabled }
        });
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : `The ${entry.name} key could not be saved` };
    }

    revalidatePath("/integrations/models");
    return {};
}

/** Forget a model provider's key. Rotating one is a paste over the old value;
 *  this is for the account that is going away, where leaving the key stored
 *  would keep handing a dead credential to every run. */
export async function disconnectModelProviderAction(slug: string): Promise<{ error?: string }> {
    const user = await requireAdmin();
    const entry = findIntegration(slug);
    if (!entry || entry.category !== "Models") return { error: "Unknown model provider" };

    await upsertIntegration(entry.slug, { enabled: false, secret: null });
    await recordAudit({
        actorId: user.id,
        action: "integration.disable",
        targetType: "integration",
        targetId: entry.slug
    });
    revalidatePath("/integrations/models");
    return {};
}

/**
 * Point runs at an OpenAI-compatible endpoint instead of a provider key.
 *
 * The two limits are asked for rather than guessed: an endpoint publishes no
 * catalog, and a run that assumes one answers in 32000-token slices and never
 * compacts. The token is optional - an endpoint on this network frequently
 * accepts unauthenticated calls - which is why it is the one credential here
 * that does not gate the switch.
 */
export async function saveGatewayAction(input: {
    enabled: boolean;
    baseUrl: string;
    model: string;
    context: number;
    maxOutput: number;
    token?: string;
}): Promise<{ error?: string }> {
    const user = await requireAdmin();
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
    const model = input.model.trim();
    const context = Math.floor(input.context);
    const maxOutput = Math.floor(input.maxOutput);

    if (baseUrl && !/^https?:\/\/\S+$/.test(baseUrl)) return { error: "The base URL has to start with http:// or https://" };
    if (input.enabled) {
        if (!baseUrl) return { error: "Add the base URL before enabling it" };
        if (!model) return { error: "Add the model id the endpoint serves" };
        if (!(context > 0) || !(maxOutput > 0)) return { error: "Set both token limits to a number above zero" };
        if (maxOutput > context) return { error: "The largest answer cannot exceed the context window" };
    }

    try {
        await upsertIntegration(GATEWAY_SLUG, {
            enabled: input.enabled,
            config: { baseUrl, model, context, maxOutput },
            secret: input.token?.trim() ? input.token.trim() : undefined,
            installedById: user.id
        });
        await recordAudit({
            actorId: user.id,
            action: "integration.configure",
            targetType: "integration",
            targetId: GATEWAY_SLUG,
            metadata: { enabled: input.enabled }
        });
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "The gateway settings could not be saved" };
    }

    revalidatePath("/integrations/models");
    return {};
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
