"use server";

/**
 * Domain security, from the two places it is shown: an owner's domain page
 * (a person's, or an organization's) and the administrator's list of every
 * domain Polaris knows.
 *
 * Who is asking is decided here and nowhere else: an owner reference is cleared
 * the way every other action on a brought domain is (`domainCallerFor`), and the
 * administrator's view needs an administrator. Errors come back as `{ error }`
 * in the reader's language rather than thrown, so one refusal does not replace
 * the screen with an error boundary.
 */

import { z } from "zod";
import { requireUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { getTranslations } from "@/lib/i18n/request";
import * as security from "@/lib/domain-security/service";
import { domainCallerFor } from "@/lib/owner-domain-caller";
import { fingerprint, type PlannedChange } from "@/lib/domain-security/plan";

const refSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("admin") }),
    z.object({ kind: z.literal("user") }),
    z.object({ kind: z.literal("org"), orgId: z.string().uuid() })
]);

/** Which page is asking: an owner's, or the administrator's list. */
export type SecurityRef = z.infer<typeof refSchema>;

const domainSchema = z
    .string()
    .trim()
    .toLowerCase()
    .max(253)
    .regex(/^[a-z0-9.-]+$/);
const policySchema = z.enum(["quarantine", "reject"]).nullable();

async function actorFor(input: unknown): Promise<security.DomainActor> {
    const ref = refSchema.parse(input);
    if (ref.kind === "admin") {
        const user = await requireUser();
        if (!user.isAdmin) throw new security.DomainSecurityError("errors.notFound");
        return { userId: user.id, isAdmin: true, owner: null };
    }
    const caller = await domainCallerFor(ref);
    return { userId: caller.userId, isAdmin: caller.isAdmin, owner: caller.owner };
}

async function failure(caught: unknown): Promise<{ error: string }> {
    const t = await getTranslations("domainSecurity");
    if (caught instanceof security.DomainSecurityError) return { error: t(caught.key) };
    if (caught instanceof z.ZodError) return { error: t("errors.notFound") };
    console.error(caught);
    return { error: t("errors.failed") };
}

export async function readDomainSecurityAction(ref: SecurityRef, domain: string): Promise<{ view?: security.DomainSecurityView; error?: string }> {
    try {
        return { view: await security.domainSecurityView(await actorFor(ref), domainSchema.parse(domain)) };
    } catch (caught) {
        return failure(caught);
    }
}

export async function recheckDomainSecurityAction(ref: SecurityRef, domain: string): Promise<{ view?: security.DomainSecurityView; error?: string }> {
    try {
        return { view: await security.recheckDomain(await actorFor(ref), domainSchema.parse(domain)) };
    } catch (caught) {
        return failure(caught);
    }
}

export type PreviewChange = PlannedChange & { readonly fingerprint: string };

export async function planDomainSecurityAction(
    ref: SecurityRef,
    domain: string,
    policy: "quarantine" | "reject" | null
): Promise<{ changes?: PreviewChange[]; error?: string }> {
    try {
        const changes = await security.planFor(await actorFor(ref), domainSchema.parse(domain), policySchema.parse(policy));
        return { changes: changes.map((change) => ({ ...change, fingerprint: fingerprint(change) })) };
    } catch (caught) {
        return failure(caught);
    }
}

export async function applyDomainSecurityAction(
    ref: SecurityRef,
    domain: string,
    approved: string[],
    policy: "quarantine" | "reject" | null
): Promise<{ results?: security.ChangeResult[]; view?: security.DomainSecurityView; error?: string }> {
    try {
        const actor = await actorFor(ref);
        const name = domainSchema.parse(domain);
        const chosen = z.array(z.string().max(4096)).min(1).max(50).parse(approved);
        const outcome = await security.applyFor(actor, name, chosen, policySchema.parse(policy));
        await recordAudit({
            actorId: actor.userId,
            orgId: actor.owner?.kind === "org" ? actor.owner.id : undefined,
            action: "domain.security.fix",
            targetType: "domain",
            targetId: name,
            metadata: { applied: outcome.results.filter((result) => result.ok).length, failed: outcome.results.filter((result) => !result.ok).length, policy }
        });
        return outcome;
    } catch (caught) {
        return failure(caught);
    }
}

export async function setDomainDedicatedAction(
    ref: SecurityRef,
    domain: string,
    dedicated: boolean
): Promise<{ view?: security.DomainSecurityView; error?: string }> {
    try {
        const actor = await actorFor(ref);
        const name = domainSchema.parse(domain);
        const view = await security.setDedicated(actor, name, z.boolean().parse(dedicated));
        await recordAudit({
            actorId: actor.userId,
            orgId: actor.owner?.kind === "org" ? actor.owner.id : undefined,
            action: dedicated ? "domain.security.dedicate" : "domain.security.undedicate",
            targetType: "domain",
            targetId: name
        });
        return { view };
    } catch (caught) {
        return failure(caught);
    }
}

export async function securityInventoryAction(): Promise<{ domains?: security.InventoryEntry[]; error?: string }> {
    try {
        const actor = await actorFor({ kind: "admin" });
        return { domains: await security.securityInventory(actor) };
    } catch (caught) {
        return failure(caught);
    }
}
