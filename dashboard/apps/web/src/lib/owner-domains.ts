/**
 * Domains people bring themselves, for their own deployed services.
 *
 * The operator's zones are configuration: they are what the dashboard is reached
 * on, they live in Settings, and nothing here can touch them. These are something
 * else - a domain one account or one organization owns, verified as theirs, and
 * used to give their own services hostnames. A company running its work on a
 * shared Polaris should be able to publish on its own name without being handed
 * the instance's DNS settings, and that is the whole of what this is for.
 *
 * Whether it is offered at all is the operator's call. Somebody who hands out
 * accounts on their box may not want strangers pointing arbitrary domains at it
 * and asking Let's Encrypt to certify them, so the policy has an off switch and a
 * per-owner cap.
 *
 * Two independent checks decide whether a domain works, and both matter:
 *
 *   1. A TXT record proves the person adding it controls the domain. Without it
 *      anybody could claim a name they do not own and be issued certificates for
 *      hostnames under it.
 *   2. A wildcard record proves traffic for it arrives at this server. Without it
 *      a hostname is minted that resolves nowhere, and the certificate order that
 *      follows retries until it is rate-limited.
 *
 * A domain with the first and not the second is understood but not yet usable,
 * and the screen says which of the two is missing rather than "not verified".
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { isIpv4 } from "@polaris/core";
import { grantedResourceIds } from "@polaris/auth";
import { randomBytes } from "node:crypto";
import { detectPublicIp } from "./network-service";
import { resolve4, resolveTxt } from "node:dns/promises";
import { getSetting, setSetting } from "./setting-store";
import { isBaseDomain, normalizeBaseDomain, randomLabel } from "@polaris/deploy";
import {
    ownerDomainPolicySchema,
    instanceDomainConflict,
    OWNER_DOMAIN_POLICY_DEFAULTS,
    type OwnerDomainPolicy
} from "./owner-domains-policy";

// The vocabulary the settings form and this module both read. Re-exported so a
// server caller has one import for the subject, while the form keeps importing
// the pure module directly - reaching this one from the browser would drag
// Prisma, node:dns and the SSH stack into the bundle.
export {
    ownerDomainPolicySchema,
    instanceDomainConflict,
    OWNER_DOMAIN_HINTS,
    OWNER_DOMAIN_LABELS,
    OWNER_DOMAIN_MODES,
    OWNER_DOMAIN_POLICY_DEFAULTS,
    type OwnerDomainMode,
    type OwnerDomainPolicy
} from "./owner-domains-policy";

const POLICY_KEY = "domains.owner.policy";

/** The label the proof-of-ownership record is published under. Fixed, so the
 *  instructions are the same on every screen and every registrar. */
export const OWNER_DOMAIN_TXT_LABEL = "_polaris";

export async function ownerDomainPolicy(): Promise<OwnerDomainPolicy> {
    const stored = await getSetting(POLICY_KEY);
    if (!stored) return OWNER_DOMAIN_POLICY_DEFAULTS;
    try {
        const parsed = ownerDomainPolicySchema.safeParse(JSON.parse(stored));
        // A setting written by an older version can be missing fields a newer one
        // reads; the schema's defaults fill those rather than the whole value
        // being discarded.
        return parsed.success ? parsed.data : OWNER_DOMAIN_POLICY_DEFAULTS;
    } catch {
        return OWNER_DOMAIN_POLICY_DEFAULTS;
    }
}

export async function setOwnerDomainPolicy(input: unknown): Promise<OwnerDomainPolicy> {
    const parsed = ownerDomainPolicySchema.safeParse(input);
    if (!parsed.success) throw new OwnerDomainError(parsed.error.issues[0]?.message ?? "Check the settings");
    await setSetting(POLICY_KEY, JSON.stringify(parsed.data));
    return parsed.data;
}

export class OwnerDomainError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "OwnerDomainError";
    }
}

/**
 * The hostnames this Polaris itself answers on or mints under.
 *
 * Read straight out of the settings rather than through `domain-service` and
 * `domain-zones`: those two ask this module which owner domains are usable when
 * they build the deploy-zone list, so importing them back here would close the
 * loop. The keys are the only thing duplicated, and they are the stable half.
 *
 * A malformed or missing value contributes nothing rather than throwing - the
 * check is a refusal, and an instance whose own domain cannot be read must not
 * become an instance where nobody can add a domain.
 */
export async function instanceDomains(): Promise<string[]> {
    const [zonesRaw, app, sharing, extraRaw] = await Promise.all([
        getSetting("domain.zones"),
        getSetting("domain.app"),
        getSetting("domain.sharing"),
        getSetting("domain.extra")
    ]);

    const hosts: string[] = [];
    const add = (value: string | null | undefined) => {
        const host = normalizeBaseDomain(value ?? "");
        if (host && isBaseDomain(host) && !hosts.includes(host)) hosts.push(host);
    };

    add(zoneBaseDomain(zonesRaw));
    add(app);
    add(sharing);
    // Whatever the instance was started with, which is what a deployment that has
    // never opened the domain settings is actually reached on.
    add(process.env.POLARIS_APP_URL);
    for (const entry of parseStringList(extraRaw)) add(entry);
    return hosts;
}

function zoneBaseDomain(raw: string | null): string {
    if (!raw) return "";
    try {
        const parsed: unknown = JSON.parse(raw);
        const base = (parsed as { baseDomain?: unknown } | null)?.baseDomain;
        return typeof base === "string" ? base : "";
    } catch {
        return "";
    }
}

function parseStringList(raw: string | null): string[] {
    if (!raw) return [];
    try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
    } catch {
        return [];
    }
}

// ---------------------------------------------------------------------------
// Owners
// ---------------------------------------------------------------------------

/** Whose domain it is. Exactly one, always - a domain belongs to one account or
 *  to one organization, and the service is the only writer of these rows, which
 *  is what makes that hold. */
export type DomainOwner = { readonly kind: "user"; readonly id: string } | { readonly kind: "org"; readonly id: string };

function ownerWhere(owner: DomainOwner) {
    return owner.kind === "user" ? { userId: owner.id } : { orgId: owner.id };
}

/** What a caller may submit: one domain, normalized before it is checked, so
 *  `https://Example.com/` and `*.example.com` both arrive as `example.com`. */
export const ownerDomainInputSchema = z.object({
    domain: z
        .string()
        .transform(normalizeBaseDomain)
        .refine(isBaseDomain, "Enter a domain like example.com")
        // An address passes the domain pattern - four groups of digits separated
        // by dots is a well-formed name as far as the syntax goes - and is not a
        // domain: nothing can publish a TXT record under it, so it would sit here
        // unverifiable forever while looking like a claim somebody made.
        .refine((value) => !isIpv4(value), "That is an address, not a domain")
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface OwnerDomainView {
    readonly id: string;
    readonly domain: string;
    /** The TXT record the owner has to publish, as name and value. */
    readonly txtName: string;
    readonly txtValue: string;
    /** The wildcard record that makes every hostname under it arrive here. */
    readonly wildcard: string;
    readonly verified: boolean;
    /** True when the wildcard was last seen pointing at this server. A domain is
     *  only usable when both this and `verified` are true. */
    readonly wildcardOk: boolean;
    readonly checkedAt: string | null;
    readonly detail: string;
    readonly createdAt: string;
}

function toView(row: {
    id: string;
    domain: string;
    verifyToken: string;
    verifiedAt: Date | null;
    wildcardOk: boolean;
    checkedAt: Date | null;
    checkDetail: string | null;
    createdAt: Date;
}): OwnerDomainView {
    return {
        id: row.id,
        domain: row.domain,
        txtName: `${OWNER_DOMAIN_TXT_LABEL}.${row.domain}`,
        txtValue: row.verifyToken,
        wildcard: `*.${row.domain}`,
        verified: row.verifiedAt !== null,
        wildcardOk: row.wildcardOk,
        checkedAt: row.checkedAt?.toISOString() ?? null,
        detail: row.checkDetail ?? "",
        createdAt: row.createdAt.toISOString()
    };
}

/**
 * The domains on this shelf, plus any this account was given access to.
 *
 * A zone belongs to one account or one organization, and until now that was the
 * only way to reach it - so handing somebody the domain a service answers on
 * meant handing them the account. A grant written for one zone widens the list
 * without widening anything else.
 */
export async function listOwnerDomains(owner: DomainOwner): Promise<OwnerDomainView[]> {
    const mine = ownerWhere(owner);
    const granted =
        owner.kind === "user" ? (await grantedResourceIds(owner.id, "domain", "deploy.manage")).ids : [];
    const rows = await prisma.ownerDomain.findMany({
        where: granted.length > 0 ? { OR: [mine, { id: { in: granted } }] } : mine,
        orderBy: { createdAt: "asc" }
    });
    return rows.map(toView);
}

/**
 * The domains this owner may actually mint hostnames under.
 *
 * Both halves proven, because either one missing produces a URL that does not
 * work: an unverified domain is one somebody else may own, and one without the
 * wildcard resolves nowhere. Deploy reads this and nothing else.
 */
export async function usableOwnerDomains(owner: DomainOwner): Promise<string[]> {
    const rows = await prisma.ownerDomain.findMany({
        where: { ...ownerWhere(owner), verifiedAt: { not: null }, wildcardOk: true },
        orderBy: { domain: "asc" },
        select: { domain: true }
    });
    return rows.map((row) => row.domain);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Whether this owner may add another one right now, and why not when they may
 *  not - the screen has to say, rather than showing a button that refuses. */
export async function canAddOwnerDomain(
    owner: DomainOwner,
    isAdmin: boolean
): Promise<{ ok: true } | { ok: false; reason: string }> {
    const policy = await ownerDomainPolicy();
    if (policy.mode === "off") return { ok: false, reason: "This Polaris does not take domains of your own" };
    if (policy.mode === "admins" && !isAdmin) {
        return { ok: false, reason: "Only an administrator can add a domain on this Polaris" };
    }
    if (policy.maxPerOwner > 0) {
        const held = await prisma.ownerDomain.count({ where: ownerWhere(owner) });
        if (held >= policy.maxPerOwner) {
            return { ok: false, reason: `This Polaris allows ${policy.maxPerOwner} domains per owner` };
        }
    }
    return { ok: true };
}

/**
 * Claim a domain.
 *
 * Nothing is trusted yet: the row exists so the owner can be told which records
 * to publish, and it reaches nothing at all until a check confirms both. The
 * token is minted here and never reused - re-adding a domain that was removed
 * gets a new one, so a TXT record left behind at the registrar cannot re-verify a
 * claim somebody else has since made.
 */
export async function addOwnerDomain(owner: DomainOwner, input: unknown, isAdmin: boolean): Promise<OwnerDomainView> {
    const parsed = ownerDomainInputSchema.safeParse(input);
    if (!parsed.success) throw new OwnerDomainError(parsed.error.issues[0]?.message ?? "Enter a domain like example.com");

    const allowed = await canAddOwnerDomain(owner, isAdmin);
    if (!allowed.ok) throw new OwnerDomainError(allowed.reason);

    const domain = parsed.data.domain;
    // Polaris's own name is not on offer. Claiming it - or its parent - would
    // hand the claimant proof of ownership over the address the dashboard is
    // reached on, and certificates for every hostname under it.
    const reserved = instanceDomainConflict(domain, await instanceDomains());
    if (reserved) throw new OwnerDomainError(reserved);

    const taken = await prisma.ownerDomain.findUnique({ where: { domain }, select: { id: true } });
    // One claim per name across the instance. Two owners both being issued
    // certificates for hostnames under one domain is not something to sort out
    // later, and the message says nothing about who holds it.
    if (taken) throw new OwnerDomainError("That domain is already claimed on this Polaris");

    const row = await prisma.ownerDomain.create({
        data: {
            ...ownerWhere(owner),
            domain,
            verifyToken: `polaris-verify=${randomBytes(16).toString("hex")}`
        }
    });
    return toView(row);
}

/** Give up a domain. The services already deployed on hostnames under it keep
 *  their rows - taking a name away is the operator's or the owner's decision per
 *  service, not something a click here does to a running deployment. */
export async function removeOwnerDomain(owner: DomainOwner, id: string): Promise<void> {
    const removed = await prisma.ownerDomain.deleteMany({ where: { id, ...ownerWhere(owner) } });
    if (removed.count === 0) throw new OwnerDomainError("That domain is not one of yours");
}

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

/** Resolve one name, returning nothing rather than throwing on NXDOMAIN. */
async function txtOrEmpty(hostname: string): Promise<string[]> {
    try {
        // Node hands back each record as its chunks; a long value is split at 255
        // characters by the protocol itself, so they are joined before comparing.
        return (await resolveTxt(hostname)).map((chunks) => chunks.join(""));
    } catch {
        return [];
    }
}

async function addressesOrEmpty(hostname: string): Promise<string[]> {
    try {
        return await resolve4(hostname);
    } catch {
        return [];
    }
}

/**
 * Ask DNS about one domain and record what it said.
 *
 * The wildcard is checked by resolving a name nobody ever created: nothing but a
 * wildcard record could answer for it, which is what makes the answer proof
 * rather than a guess about one hostname somebody happened to set up.
 *
 * Ownership, once proven, stays proven. A TXT record removed after the fact does
 * not un-verify a domain - certificates and links already exist under it, and
 * pulling the ground out from under a running deployment because a registrar
 * record was tidied up is worse than the thing it would protect against.
 */
export async function checkOwnerDomain(owner: DomainOwner, id: string): Promise<OwnerDomainView> {
    const row = await prisma.ownerDomain.findFirst({ where: { id, ...ownerWhere(owner) } });
    if (!row) throw new OwnerDomainError("That domain is not one of yours");

    const [txt, wildcardAddresses, expectedIp] = await Promise.all([
        txtOrEmpty(`${OWNER_DOMAIN_TXT_LABEL}.${row.domain}`),
        addressesOrEmpty(`${randomLabel(8)}.${row.domain}`),
        detectPublicIp()
    ]);

    const owns = row.verifiedAt !== null || txt.includes(row.verifyToken);
    // Without a known public IP the record can only be confirmed to exist, not
    // compared - which is still the useful half of the answer, and better than
    // refusing a domain because this box cannot work out its own address.
    const pointsHere = wildcardAddresses.length > 0 && (!expectedIp || wildcardAddresses.includes(expectedIp));

    const detail = !owns
        ? `No ${OWNER_DOMAIN_TXT_LABEL}.${row.domain} TXT record with that value yet. Records can take a few minutes to appear.`
        : wildcardAddresses.length === 0
          ? `No DNS answer for *.${row.domain} yet. Add the wildcard record, then check again.`
          : !pointsHere
            ? `*.${row.domain} resolves to ${wildcardAddresses.join(", ")}, but this server is at ${expectedIp}.`
            : "Verified. Services here can take hostnames under this domain.";

    const updated = await prisma.ownerDomain.update({
        where: { id: row.id },
        data: {
            verifiedAt: owns ? (row.verifiedAt ?? new Date()) : null,
            wildcardOk: pointsHere,
            checkedAt: new Date(),
            checkDetail: detail
        }
    });
    return toView(updated);
}
