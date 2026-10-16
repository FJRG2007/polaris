/**
 * SAML identity providers as an administrator manages them: saved, checked and
 * removed. Sign-in itself is the auth package's.
 *
 * A provider signs nobody in until every one of its domains carries the DNS
 * record shown on its card - that is what stops an administrator, or whoever
 * holds an administrator's session, from routing somebody else's domain through
 * an identity provider they control.
 */

import "server-only";

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import * as auth from "@polaris/auth";
import { loadEnv } from "@polaris/config";
import { randomBytes } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { follow, readCapped, safeUrl } from "@/lib/safe-fetch";

/** One provider as the admin screen draws it. */
export interface SamlProviderView {
    providerId: string;
    name: string;
    domains: string[];
    allowSignUp: boolean;
    enforced: boolean;
    domainVerified: boolean;
    entityId: string;
    ssoUrl: string;
    mapping: core.SamlMapping;
    serviceProvider: { entityId: string; acsUrl: string; metadataUrl: string };
    records: { name: string; value: string }[];
}

/** Why a save or a check did not go through, as the screen words it. */
export type SamlProblem = auth.IdpProblem | "fetch" | "domainTaken" | "notFound";

export class SamlProviderError extends Error {
    constructor(readonly problem: SamlProblem) {
        super(`SAML provider: ${problem}`);
    }
}

function appUrl(): string {
    return loadEnv().POLARIS_APP_URL;
}

function view(row: {
    providerId: string;
    name: string;
    domain: string;
    allowSignUp: boolean;
    enforced: boolean;
    domainVerified: boolean;
    domainToken: string;
    samlConfig: string | null;
}): SamlProviderView {
    const stored = auth.storedIdpDetails(row.samlConfig);
    const domains = core.parseSamlDomains(row.domain);
    return {
        providerId: row.providerId,
        name: row.name,
        domains,
        allowSignUp: row.allowSignUp,
        enforced: row.enforced,
        domainVerified: row.domainVerified,
        entityId: stored?.entityId ?? "",
        ssoUrl: stored?.ssoUrl ?? "",
        mapping: stored?.mapping ?? core.DEFAULT_SAML_MAPPING,
        serviceProvider: core.samlServiceProviderUrls(appUrl(), row.providerId),
        records: domains.map((domain) => core.samlDomainRecord(domain, row.domainToken))
    };
}

const SELECT = {
    providerId: true,
    name: true,
    domain: true,
    allowSignUp: true,
    enforced: true,
    domainVerified: true,
    domainToken: true,
    samlConfig: true
} as const;

export async function listSamlProviders(): Promise<SamlProviderView[]> {
    const rows = await prisma.ssoProvider.findMany({ select: SELECT, orderBy: { createdAt: "asc" }, take: 100 });
    return rows.map(view);
}

/** The metadata document at an https address, through the guarded fetch. */
async function fetchMetadata(address: string): Promise<string> {
    const url = safeUrl(address);
    if (!url || url.protocol !== "https:") throw new SamlProviderError("fetch");
    const response = await follow(url, "application/samlmetadata+xml, application/xml, text/xml").catch(() => null);
    if (!response || !response.ok) throw new SamlProviderError("fetch");
    const bytes = await readCapped(response, core.SAML_MAX_METADATA_LENGTH);
    if (!bytes) throw new SamlProviderError("fetch");
    return new TextDecoder().decode(bytes);
}

async function idpDetails(source: core.SamlSource, samlConfig: string | null): Promise<auth.IdpDetails> {
    try {
        if (source.kind === "current") {
            const stored = auth.storedIdpDetails(samlConfig);
            if (!stored?.entityId || !stored.ssoUrl || !stored.certificate) throw new SamlProviderError("metadata");
            return { entityId: stored.entityId, ssoUrl: stored.ssoUrl, certificate: stored.certificate };
        }
        if (source.kind === "manual") return auth.manualIdpDetails(source);
        const xml = source.kind === "metadataXml" ? source.xml : await fetchMetadata(source.url);
        return auth.readIdpMetadata(xml);
    } catch (error) {
        if (error instanceof auth.IdpConfigError) throw new SamlProviderError(error.problem);
        throw error;
    }
}

/** Refuses a domain another provider already routes, so an address has one way in. */
async function assertDomainsFree(domains: readonly string[], providerId: string | null): Promise<void> {
    const others = (await auth.samlDomainPolicies()).filter((entry) => entry.providerId !== providerId);
    for (const domain of domains) {
        if (others.some((other) => other.domains.includes(domain))) throw new SamlProviderError("domainTaken");
    }
}

/**
 * Creates or replaces a provider. Changing its domains un-verifies it, since the
 * proof was for the old ones.
 */
export async function saveSamlProvider(
    input: core.SamlProviderInput,
    adminId: string,
    providerId: string | null
): Promise<SamlProviderView> {
    const existing = providerId
        ? await prisma.ssoProvider.findUnique({ where: { providerId }, select: SELECT })
        : null;
    if (providerId && !existing) throw new SamlProviderError("notFound");
    await assertDomainsFree(input.domains, providerId);
    // Keeping the saved details only means something for a provider that has them.
    if (input.source.kind === "current" && !existing) throw new SamlProviderError("notFound");
    const idp = await idpDetails(input.source, existing?.samlConfig ?? null);
    const id = providerId ?? `saml-${randomBytes(12).toString("hex").slice(0, 20)}`;
    const domain = input.domains.join(",");
    const samlConfig = auth.samlPluginConfig({ appUrl: appUrl(), providerId: id, idp, mapping: input.mapping });
    const sameDomains = existing?.domain === domain;
    const data = {
        name: input.name,
        issuer: idp.entityId,
        domain,
        samlConfig,
        allowSignUp: input.allowSignUp,
        enforced: input.enforced,
        domainVerified: sameDomains ? existing.domainVerified : false
    };
    const row = existing
        ? await prisma.ssoProvider.update({ where: { providerId: id }, data, select: SELECT })
        : await prisma.ssoProvider.create({
              data: { ...data, providerId: id, userId: adminId, domainToken: randomBytes(18).toString("base64url") },
              select: SELECT
          });
    return view(row);
}

export async function deleteSamlProvider(providerId: string): Promise<void> {
    await prisma.ssoProvider.deleteMany({ where: { providerId } });
}

/** One line of a provider check, for the screen to tick or cross. */
export interface SamlCheck {
    key: "certificate" | "metadata" | "domain";
    ok: boolean;
    detail?: string;
}

async function hasRecord(record: { name: string; value: string }): Promise<boolean> {
    try {
        const answers = await resolveTxt(record.name);
        return answers.some((chunks) => chunks.join("") === record.value);
    } catch {
        return false;
    }
}

/**
 * Checks a saved provider the way sign-in will meet it: the certificate is still
 * valid, the metadata address (when it has one) still answers, and every domain
 * carries its record. A provider whose domains all pass is marked verified; one
 * that no longer passes is not, so it stops signing people in.
 */
export async function checkSamlProvider(providerId: string): Promise<SamlCheck[]> {
    const row = await prisma.ssoProvider.findUnique({ where: { providerId }, select: SELECT });
    if (!row) throw new SamlProviderError("notFound");
    const current = view(row);
    const stored = auth.storedIdpDetails(row.samlConfig);
    const checks: SamlCheck[] = [];
    try {
        auth.readCertificate(stored?.certificate ?? "");
        checks.push({ key: "certificate", ok: true });
    } catch {
        checks.push({ key: "certificate", ok: false });
    }
    if (stored?.ssoUrl) {
        const url = safeUrl(stored.ssoUrl);
        const answered = url ? await follow(url).then((response) => response !== null, () => false) : false;
        checks.push({ key: "metadata", ok: answered });
    }
    let allDomains = true;
    for (const record of current.records) {
        const ok = await hasRecord(record);
        allDomains &&= ok;
        checks.push({ key: "domain", ok, detail: record.name });
    }
    if (allDomains !== row.domainVerified) {
        await prisma.ssoProvider.update({ where: { providerId }, data: { domainVerified: allDomains } });
    }
    return checks;
}

/** Whether an address's domain signs in through a working provider, for the sign-in screen. */
export async function ssoOfferedFor(email: string): Promise<boolean> {
    const provider = core.providerForEmail(email, await auth.samlDomainPolicies());
    return Boolean(provider?.domainVerified);
}
