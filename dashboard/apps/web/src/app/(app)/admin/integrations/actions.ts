"use server";

/**
 * Integrations admin actions. Configuring an integration stores an instance-wide
 * secret, so every action here is admin-gated. The API key is tri-state: a new
 * non-empty value replaces the stored one, an empty value keeps it. Enabling an
 * integration that needs a key with none on file is rejected up front.
 */

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { setSetting } from "@/lib/setting-store";
import { recordAudit } from "@/lib/audit-service";
import { verifyIp } from "@/lib/integrations/dymo";
import { applyTunnel } from "@/lib/tunnel-service";
import { STEAM_PROVIDER } from "@/lib/connections/steam";
import { verifyKey } from "@/lib/integrations/virustotal";
import { CRIMINALIP_RULES } from "@/lib/integrations/criminalip";
import type { GoogleApiHealth } from "@/lib/connections/google-api-health";
import type { CfAccount } from "@/lib/integrations/cloudflare-api";
import { setDomainConfig, syncDuckDns } from "@/lib/domain-service";
import { isTunnelToken } from "@/lib/integrations/tunnel-token";
import type { CloudflareTokenScope } from "@/lib/integrations/cloudflare-token-link";
import { DYMO_IP_RULES, findIntegration, type ScanAction } from "@/lib/integrations/registry";
import { connectGithubApp, disconnectGithub, refreshInstallations } from "@/lib/github-service";
import {
    getIntegrationSecret,
    getIntegrationState,
    upsertIntegration
} from "@/lib/integration-service";
import {
    OAUTH_APP_SLUGS,
    connectionRedirectUri,
    verifyConnectionOAuthApp
} from "@/lib/connections/oauth";
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
export async function saveConnectionLimitAction(
    provider: string,
    limit: number
): Promise<{ error?: string }> {
    const user = await requireAdmin();
    const t = await getTranslations("admin");
    if (!findConnectionProvider(provider)) return { error: t("integrations.errors.unknownService") };
    if (!Number.isInteger(limit) || limit < 0 || limit > MAX_ACCOUNTS_PER_USER) {
        return { error: t("integrations.errors.limitRange", { max: MAX_ACCOUNTS_PER_USER }) };
    }

    await setSetting(connectionLimitKey(provider), String(limit));
    await recordAudit({
        actorId: user.id,
        action: "integration.configure",
        targetType: "integration",
        targetId: provider,
        metadata: { accountsPerUser: limit }
    });
    revalidatePath("/admin/integrations");
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
export async function saveConnectionSignInAction(
    provider: string,
    allowed: boolean
): Promise<{ error?: string }> {
    const user = await requireAdmin();
    const t = await getTranslations("admin");
    if (!findConnectionProvider(provider)) return { error: t("integrations.errors.unknownService") };

    await setSetting(connectionSignInKey(provider), allowed === true ? "true" : "false");
    await recordAudit({
        actorId: user.id,
        action: "integration.configure",
        targetType: "integration",
        targetId: provider,
        metadata: { signIn: allowed === true }
    });
    revalidatePath("/admin/integrations");
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
    const t = await getTranslations("admin");
    const entry = findConnectionProvider(provider);
    if (!entry) return { error: t("integrations.errors.unknownService") };
    if (entry.emailTrustDefault === undefined)
        return { error: t("integrations.errors.noAddress", { name: entry.name }) };

    await setSetting(connectionEmailTrustKey(provider), trusted === true ? "true" : "false");
    await recordAudit({
        actorId: user.id,
        action: "integration.configure",
        targetType: "integration",
        targetId: provider,
        metadata: { emailTrust: trusted === true }
    });
    revalidatePath("/admin/integrations");
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
    const t = await getTranslations("admin");
    const slug = input.slug;
    if (!OAUTH_APP_SLUGS.includes(slug)) {
        return { error: t("integrations.errors.notOAuthApp") };
    }
    const clientId = input.clientId.trim();
    const clientSecret = input.clientSecret?.trim() ? input.clientSecret.trim() : undefined;

    try {
        const existing = await getIntegrationState(slug);
        if (input.enabled && !clientId) return { error: t("integrations.errors.clientIdFirst") };
        if (input.enabled && !clientSecret && !existing?.hasSecret) {
            return { error: t("integrations.errors.clientSecretFirst") };
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
        return {
            error:
                caught instanceof Error
                    ? caught.message
                    : t("integrations.errors.applicationNotSaved")
        };
    }

    revalidatePath("/admin/integrations");
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
export async function saveSteamAction(input: {
    enabled: boolean;
    apiKey?: string;
}): Promise<{ error?: string }> {
    const user = await requireAdmin();
    const t = await getTranslations("admin");
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
        return {
            error:
                caught instanceof Error ? caught.message : t("integrations.errors.steamNotSaved")
        };
    }

    revalidatePath("/admin/integrations");
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
    const t = await getTranslations("admin");
    const moduleUrl = input.moduleUrl.trim();

    if (input.enabled) {
        let parsed: URL;
        try {
            parsed = new URL(moduleUrl);
        } catch {
            return { error: t("integrations.errors.notAnAddress") };
        }
        if (parsed.protocol !== "https:") return { error: t("integrations.errors.httpsOnly") };
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
            error: caught instanceof Error ? caught.message : t("integrations.errors.notSaved")
        };
    }

    revalidatePath("/admin/integrations");
    return {};
}

/**
 * Turn the GIF and sticker search on, with the key it runs on.
 *
 * Nothing else in Polaris changes when this is off: the picker still offers
 * emoji, what each person has kept, and anything sent by its address. This is
 * one tab in one popover, which is why it is a key and a switch and no settings.
 *
 * Two services can answer that tab and they are configured identically - a key
 * and a switch - so this takes the slug rather than existing twice. Which of
 * them the picker actually asks is decided where the search is made, not here.
 */
export async function saveTenorAction(input: {
    enabled: boolean;
    apiKey?: string;
    /** `tenor` or `giphy`. Anything else is refused rather than written: this
     *  writes an integration row, and the slug is the row. */
    slug?: string;
}): Promise<{ error?: string }> {
    const user = await requireAdmin();
    const t = await getTranslations("admin");
    const slug = input.slug === "giphy" ? "giphy" : "tenor";
    const apiKey = input.apiKey?.trim() ? input.apiKey.trim() : undefined;
    try {
        const existing = await getIntegrationState(slug);
        if (input.enabled && !apiKey && !existing?.hasSecret) {
            return { error: t("integrations.errors.apiKeyFirst") };
        }
        await upsertIntegration(slug, {
            enabled: input.enabled,
            secret: apiKey,
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
        return {
            error: caught instanceof Error ? caught.message : t("integrations.errors.notSaved")
        };
    }

    revalidatePath("/admin/integrations");
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
    const t = await getTranslations("admin");
    const provider = input.provider;
    if (provider !== "cloudflare" && provider !== "ngrok")
        return { error: t("integrations.errors.unknownTunnel") };
    const newToken = input.token && input.token.trim() ? input.token.trim() : undefined;
    if (newToken && !isTunnelToken(provider, newToken)) return { error: t(`integrations.tunnelHint.${provider}`) };

    try {
        const existing = await getIntegrationState(provider);
        const willHaveToken = Boolean(newToken) || Boolean(existing?.hasSecret);
        if (input.enabled && !willHaveToken) return { error: t("integrations.errors.tokenFirst") };

        if (input.enabled) {
            // Only one tunnel per server - turn the other provider off.
            const other = provider === "cloudflare" ? "ngrok" : "cloudflare";
            await upsertIntegration(other, { enabled: false });
        }
        await upsertIntegration(provider, {
            enabled: input.enabled,
            secret: newToken,
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
        return {
            error:
                caught instanceof Error ? caught.message : t("integrations.errors.tunnelNotSaved")
        };
    }

    // The settings are stored either way, so the page reflects them even when the
    // container refuses to come up and the dialog stays open on the reason.
    revalidatePath("/admin/integrations");
    try {
        await applyTunnel();
    } catch (caught) {
        const detail =
            caught instanceof Error
                ? caught.message
                : t("integrations.errors.tunnelNotStartedDetail");
        return { error: t("integrations.errors.tunnelNotStarted", { detail }) };
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
    if (!subdomain) {
        const t = await getTranslations("admin");
        return { error: t("integrations.errors.duckdnsSubdomain") };
    }
    await setDomainConfig({ duckdnsSubdomain: subdomain, duckdnsToken: input.token });
    await recordAudit({
        actorId: user.id,
        action: "integration.configure",
        targetType: "integration",
        targetId: "duckdns"
    });
    // Push the record to the current IP right away so the subdomain resolves.
    await syncDuckDns().catch(() => undefined);
    revalidatePath("/admin/integrations");
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
        const result = await connectCloudflareToken(input.token, {
            scope,
            ...(input.accountId ? { accountId: input.accountId } : {})
        });
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
            revalidatePath("/admin/integrations");
        }
        return {
            connected: result.connected,
            accounts: result.accounts,
            accountName: result.accountName,
            stored: result.stored
        };
    } catch (caught) {
        const t = await getTranslations("admin");
        return {
            error:
                caught instanceof Error
                    ? caught.message
                    : t("integrations.errors.cloudflareNotConnected")
        };
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
    revalidatePath("/admin/integrations");
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
    const t = await getTranslations("admin");
    const provider = "virustotal";
    const onDetection: ScanAction = SCAN_ACTIONS.has(input.onDetection as ScanAction)
        ? (input.onDetection as ScanAction)
        : "block";

    const existing = await getIntegrationState(provider);
    const newKey = input.apiKey && input.apiKey.trim() ? input.apiKey.trim() : undefined;
    const willHaveKey = Boolean(newKey) || Boolean(existing?.hasSecret);
    if (input.enabled && !willHaveKey)
        return { error: t("integrations.errors.virusTotalKeyFirst") };

    // Validate a newly supplied key so a typo does not silently disable scanning.
    if (newKey) {
        const check = await verifyKey(newKey);
        if (!check.ok) return { error: check.error ?? t("integrations.errors.keyRejected") };
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
    revalidatePath("/admin/integrations");
    return {};
}

/** Verify a Dymo key by making one benign IP check; a bad key throws. */
async function testDymoKey(apiKey: string): Promise<{ ok: boolean; error?: string }> {
    try {
        await verifyIp(apiKey, "8.8.8.8", ["FRAUD"]);
        return { ok: true };
    } catch (caught) {
        const t = await getTranslations("admin");
        return {
            ok: false,
            error: caught instanceof Error ? caught.message : t("integrations.errors.keyRejected")
        };
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
    const t = await getTranslations("admin");
    const provider = "dymo";
    const existing = await getIntegrationState(provider);
    const newKey = input.apiKey && input.apiKey.trim() ? input.apiKey.trim() : undefined;
    const willHaveKey = Boolean(newKey) || Boolean(existing?.hasSecret);
    if (input.enabled && !willHaveKey) return { error: t("integrations.errors.dymoKeyFirst") };

    const known = new Set(DYMO_IP_RULES.map((rule) => rule.value));
    const deny = input.deny.filter((value) => known.has(value));

    if (newKey) {
        const check = await testDymoKey(newKey);
        if (!check.ok) return { error: check.error ?? t("integrations.errors.keyRejected") };
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
    revalidatePath("/admin/integrations");
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
    const t = await getTranslations("admin");
    const provider = "criminalip";
    const newKey = input.apiKey?.trim() ? input.apiKey.trim() : undefined;

    try {
        const existing = await getIntegrationState(provider);
        if (input.enabled && !newKey && !existing?.hasSecret) {
            return { error: t("integrations.errors.criminalIpKeyFirst") };
        }

        const known = new Set<string>(CRIMINALIP_RULES.map((rule) => rule.value));
        const deny = input.deny.filter((value) => known.has(value));
        if (input.enabled && deny.length === 0)
            return { error: t("integrations.errors.pickVerdict") };

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
        return {
            error:
                caught instanceof Error
                    ? caught.message
                    : t("integrations.errors.criminalIpNotSaved")
        };
    }

    revalidatePath("/admin/integrations");
    return {};
}

/** Verify a Dymo API key without saving it (the configure dialog's Test button). */
export async function testDymoKeyAction(apiKey: string): Promise<{ ok: boolean; error?: string }> {
    await requireAdmin();
    if (!apiKey.trim()) {
        const t = await getTranslations("admin");
        return { ok: false, error: t("integrations.errors.enterKeyFirst") };
    }
    return testDymoKey(apiKey.trim());
}

/** Turn an integration off without forgetting its configuration. */
export async function setIntegrationEnabledAction(
    provider: string,
    enabled: boolean
): Promise<{ error?: string }> {
    const user = await requireAdmin();
    const t = await getTranslations("admin");
    if (!findIntegration(provider)) return { error: t("integrations.errors.unknownIntegration") };
    if (enabled) {
        const state = await getIntegrationState(provider);
        if (!state?.hasSecret) return { error: t("integrations.errors.configureFirst") };
    }
    await upsertIntegration(provider, { enabled });
    await recordAudit({
        actorId: user.id,
        action: enabled ? "integration.enable" : "integration.disable",
        targetType: "integration",
        targetId: provider
    });
    revalidatePath("/admin/integrations");
    return {};
}

/** Verify an API key without saving it (the configure dialog's Test button). */
export async function testVirusTotalKeyAction(
    apiKey: string
): Promise<{ ok: boolean; error?: string }> {
    await requireAdmin();
    if (!apiKey.trim()) {
        const t = await getTranslations("admin");
        return { ok: false, error: t("integrations.errors.enterKeyFirst") };
    }
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
        await recordAudit({
            actorId: user.id,
            action: "integration.configure",
            targetType: "integration",
            targetId: "github",
            metadata: { method: "app" }
        });
        revalidatePath("/admin/integrations");
        return { installations };
    } catch (caught) {
        const t = await getTranslations("admin");
        return {
            error:
                caught instanceof Error
                    ? caught.message
                    : t("integrations.errors.githubNotConnected")
        };
    }
}

/** Refresh the stored list of app installations (after installing on more accounts). */
export async function refreshGithubInstallationsAction(): Promise<{ error?: string }> {
    await requireAdmin();
    try {
        await refreshInstallations();
        revalidatePath("/admin/integrations");
        return {};
    } catch (caught) {
        const t = await getTranslations("admin");
        return {
            error:
                caught instanceof Error
                    ? caught.message
                    : t("integrations.errors.installationsNotRefreshed")
        };
    }
}

/** Disconnect GitHub and forget its token. */
export async function disconnectGithubAction(): Promise<{ error?: string }> {
    const user = await requireAdmin();
    await disconnectGithub();
    await recordAudit({
        actorId: user.id,
        action: "integration.disable",
        targetType: "integration",
        targetId: "github"
    });
    revalidatePath("/admin/integrations");
    return {};
}

/**
 * Whether each Google API Polaris calls is switched on in the OAuth client's
 * Cloud project. Read-only and bounded (see `googleApiHealth`); `force` asks
 * Google again instead of showing an answer from the last ten minutes.
 */
export async function googleApiHealthAction(force: unknown): Promise<{ apis: GoogleApiHealth[] }> {
    const user = await requireAdmin();
    const again = z.boolean().safeParse(force).data ?? false;
    const { googleApiHealth } = await import("@/lib/connections/google-api-health");
    return { apis: await googleApiHealth(user.id, again) };
}
