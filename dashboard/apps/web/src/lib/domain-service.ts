/**
 * Domain configuration for Polaris's outward-facing URLs. Two domains are kept:
 * the app domain (the dashboard, stable) and the sharing domain (share links and
 * drop points - often a throwaway / free subdomain). Both fall back to
 * POLARIS_APP_URL when unset. DuckDNS is supported as a self-managed dynamic-DNS
 * option: its token is stored encrypted (like an integration secret) and the A
 * record can be synced to the current public IP on demand.
 *
 * Config lives in the Setting table (key/value), so no schema change is needed.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { magicDomain, DEFAULT_SUBDOMAIN_BASE } from "@polaris/deploy";
import { decryptSecret, encryptSecret } from "@polaris/storage";

const KEYS = {
    app: "domain.app",
    sharing: "domain.sharing",
    duckSub: "domain.duckdns.subdomain",
    duckToken: "domain.duckdns.token",
    deployBase: "domain.deploy.base",
    publicIp: "domain.publicIp"
} as const;

/** Non-secret domain config for the admin panel. */
export interface DomainConfig {
    appDomain: string;
    sharingDomain: string;
    duckdnsSubdomain: string;
    hasDuckdnsToken: boolean;
    /** Wildcard-DNS base for free auto subdomains (sslip.io by default). */
    deployBase: string;
    /** Public IP used to build free subdomains, when no domain is configured. */
    publicIp: string;
}

async function getSetting(key: string): Promise<string | null> {
    const row = await prisma.setting.findUnique({ where: { key }, select: { value: true } });
    return row?.value ?? null;
}

async function setSetting(key: string, value: string | null): Promise<void> {
    if (value === null) {
        await prisma.setting.deleteMany({ where: { key } });
        return;
    }
    await prisma.setting.upsert({
        where: { key },
        create: { key, value, scope: "global" },
        update: { value }
    });
}

/** Normalize a user-typed domain into an https base URL with no trailing slash. */
function normalizeUrl(value: string | null): string | null {
    if (!value || !value.trim()) return null;
    let url = value.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(url)) url = `https://${url}`;
    return url;
}

export async function getDomainConfig(): Promise<DomainConfig> {
    const [app, sharing, sub, token, base, ip] = await Promise.all([
        getSetting(KEYS.app),
        getSetting(KEYS.sharing),
        getSetting(KEYS.duckSub),
        getSetting(KEYS.duckToken),
        getSetting(KEYS.deployBase),
        getSetting(KEYS.publicIp)
    ]);
    return {
        appDomain: app ?? "",
        sharingDomain: sharing ?? "",
        duckdnsSubdomain: sub ?? "",
        hasDuckdnsToken: Boolean(token),
        deployBase: base ?? DEFAULT_SUBDOMAIN_BASE,
        publicIp: ip ?? ""
    };
}

/** The wildcard-DNS base for free auto subdomains. */
export async function deployBase(): Promise<string> {
    return (await getSetting(KEYS.deployBase)) || DEFAULT_SUBDOMAIN_BASE;
}

/** The public IP used to build free subdomains (admin-set or onboarding-set). */
export async function getPublicIp(): Promise<string | null> {
    return getSetting(KEYS.publicIp);
}

/** A free HTTPS subdomain for a named service pointing at the host, or null when
 *  no public IP is known (then callers fall back to a configured domain). */
export async function autoSubdomainUrl(name: string): Promise<string | null> {
    const ip = await getPublicIp();
    if (!ip) return null;
    return `https://${magicDomain(name, ip, await deployBase())}`;
}

/** Base URL for the dashboard/app: the configured app domain, else POLARIS_APP_URL. */
export async function appBaseUrl(): Promise<string> {
    return normalizeUrl(await getSetting(KEYS.app)) ?? loadEnv().POLARIS_APP_URL;
}

/**
 * Base URL for share links and drop points. Prefers an explicitly configured
 * sharing domain, then a DuckDNS subdomain, then a free auto subdomain (so shares
 * work with public HTTPS and zero DNS when the operator has set no domain), and
 * finally the app domain / env fallback.
 */
export async function sharingBaseUrl(): Promise<string> {
    const configured = normalizeUrl(await getSetting(KEYS.sharing));
    if (configured) return configured;

    const duckSub = await getSetting(KEYS.duckSub);
    if (duckSub) return `https://${duckSub}.duckdns.org`;

    const auto = await autoSubdomainUrl("share");
    if (auto) return auto;

    return normalizeUrl(await getSetting(KEYS.app)) ?? loadEnv().POLARIS_APP_URL;
}

/** Save domain config. Each field is tri-state: a value sets it, "" clears it,
 *  undefined leaves it. The DuckDNS token is stored encrypted. */
export async function setDomainConfig(input: {
    appDomain?: string;
    sharingDomain?: string;
    duckdnsSubdomain?: string;
    duckdnsToken?: string;
    deployBase?: string;
    publicIp?: string;
}): Promise<void> {
    if (input.appDomain !== undefined) await setSetting(KEYS.app, input.appDomain.trim() || null);
    if (input.sharingDomain !== undefined) await setSetting(KEYS.sharing, input.sharingDomain.trim() || null);
    if (input.duckdnsSubdomain !== undefined) await setSetting(KEYS.duckSub, input.duckdnsSubdomain.trim() || null);
    if (input.deployBase !== undefined) await setSetting(KEYS.deployBase, input.deployBase.trim() || null);
    if (input.publicIp !== undefined) await setSetting(KEYS.publicIp, input.publicIp.trim() || null);
    if (input.duckdnsToken !== undefined && input.duckdnsToken.trim()) {
        const blob = encryptSecret(input.duckdnsToken.trim(), loadEnv().POLARIS_MASTER_KEY);
        await setSetting(
            KEYS.duckToken,
            JSON.stringify({
                c: blob.ciphertext.toString("base64"),
                n: blob.nonce.toString("base64"),
                k: blob.keyId
            })
        );
    }
}

/** Forget the stored DuckDNS token. */
export async function clearDuckdnsToken(): Promise<void> {
    await setSetting(KEYS.duckToken, null);
}

async function getDuckdnsToken(): Promise<string | null> {
    const raw = await getSetting(KEYS.duckToken);
    if (!raw) return null;
    try {
        const { c, n, k } = JSON.parse(raw) as { c: string; n: string; k: string };
        return decryptSecret(
            { ciphertext: Buffer.from(c, "base64"), nonce: Buffer.from(n, "base64"), keyId: k },
            loadEnv().POLARIS_MASTER_KEY
        );
    } catch {
        return null;
    }
}

/** Update the DuckDNS record to the caller's current public IP. */
export async function syncDuckDns(): Promise<{ ok: boolean; detail: string }> {
    const sub = await getSetting(KEYS.duckSub);
    const token = await getDuckdnsToken();
    if (!sub || !token) return { ok: false, detail: "Set the DuckDNS subdomain and token first." };
    try {
        const res = await fetch(
            `https://www.duckdns.org/update?domains=${encodeURIComponent(sub)}&token=${encodeURIComponent(token)}&ip=`,
            { cache: "no-store" }
        );
        const text = (await res.text()).trim();
        return { ok: text.startsWith("OK"), detail: text || `HTTP ${res.status}` };
    } catch (caught) {
        return { ok: false, detail: caught instanceof Error ? caught.message : "DuckDNS request failed" };
    }
}
