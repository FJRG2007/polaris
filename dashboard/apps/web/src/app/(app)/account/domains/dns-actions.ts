"use server";

/**
 * The DNS record editor's actions: reading a zone's records, adding, changing and
 * removing them, and asking the public resolvers whether a record has reached
 * them.
 *
 * Two scopes, one set of actions. An instance zone is any zone this Polaris's
 * connected Cloudflare token reaches, and only an administrator edits one. An
 * owner zone is a domain somebody brought, edited with the token they gave it,
 * and cleared the same way every other action on that domain is.
 *
 * Errors come back as `{ error }` rather than thrown, so one refused write does
 * not replace the screen with an error boundary.
 */

import { z } from "zod";
import { requireUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { domainCallerFor } from "@/lib/owner-domain-caller";
import { dnsRecordDraftSchema } from "@/lib/dns/record-schema";
import type { PropagationReport } from "@/lib/dns/propagation";
import { CloudflareApiError } from "@/lib/integrations/cloudflare-api";
import {
    DnsEditError,
    deleteZoneRecord,
    editableZones,
    recordPropagation,
    saveZoneRecord,
    zoneRecords,
    type DnsScope,
    type DnsRecordView,
    type ZoneRecords
} from "@/lib/dns/zone-records";

const scopeSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("instance"), zoneId: z.string().max(64) }),
    z.object({
        kind: z.literal("owner"),
        ref: z.discriminatedUnion("kind", [
            z.object({ kind: z.literal("user") }),
            z.object({ kind: z.literal("org"), orgId: z.string().uuid() })
        ]),
        domainId: z.string().uuid()
    })
]);

/** What the editor sends to say which zone it is looking at. */
export type DnsScopeRef = z.infer<typeof scopeSchema>;

interface Resolved {
    readonly scope: DnsScope;
    readonly userId: string;
    readonly orgId: string | null;
}

async function resolve(input: unknown): Promise<Resolved> {
    const parsed = scopeSchema.safeParse(input);
    if (!parsed.success) throw new DnsEditError("That zone could not be read");
    const ref = parsed.data;
    if (ref.kind === "instance") {
        const user = await requireUser();
        if (!user.isAdmin)
            throw new DnsEditError("Only an administrator can edit this Polaris's DNS zones");
        return { scope: { kind: "instance", zoneId: ref.zoneId }, userId: user.id, orgId: null };
    }
    const caller = await domainCallerFor(ref.ref);
    return {
        scope: { kind: "owner", owner: caller.owner, domainId: ref.domainId },
        userId: caller.userId,
        orgId: caller.orgId
    };
}

function failure(
    caught: unknown,
    fallback: string
): { error: string; problems?: Record<string, string> } {
    if (caught instanceof DnsEditError) return { error: caught.message, problems: caught.problems };
    // Cloudflare's own refusal is worth showing: it names the field it disliked.
    if (caught instanceof CloudflareApiError) return { error: caught.message.slice(0, 300) };
    // Anything else can name internals, so it is logged and replaced.
    console.error(caught);
    return { error: fallback };
}

/** The zones an administrator can pick from. */
export async function listDnsZonesAction(): Promise<{
    zones?: { id: string; name: string }[];
    error?: string;
}> {
    try {
        const user = await requireUser();
        if (!user.isAdmin)
            return { error: "Only an administrator can edit this Polaris's DNS zones" };
        return { zones: await editableZones() };
    } catch (caught) {
        return failure(caught, "Could not read the zones");
    }
}

export async function zoneRecordsAction(
    scope: DnsScopeRef
): Promise<{ zone?: ZoneRecords; error?: string }> {
    try {
        const resolved = await resolve(scope);
        return { zone: await zoneRecords(resolved.scope) };
    } catch (caught) {
        return failure(caught, "Could not read the records");
    }
}

export async function saveDnsRecordAction(
    scope: DnsScopeRef,
    recordId: string | null,
    draft: unknown
): Promise<{ record?: DnsRecordView; error?: string; problems?: Record<string, string> }> {
    try {
        const resolved = await resolve(scope);
        const parsed = dnsRecordDraftSchema.safeParse(draft);
        if (!parsed.success) return { error: "That record could not be read" };
        if (recordId !== null && typeof recordId !== "string")
            return { error: "That record could not be read" };
        // The same schema the form checked with, run again here against the zone
        // as it is now - see `saveZoneRecord`.
        const record = await saveZoneRecord(resolved.scope, recordId, parsed.data);
        await recordAudit({
            actorId: resolved.userId,
            orgId: resolved.orgId ?? undefined,
            action: recordId ? "dns.record.update" : "dns.record.create",
            targetType: "dns-record",
            targetId: record.id,
            metadata: { type: record.type, name: record.name }
        });
        return { record };
    } catch (caught) {
        return failure(caught, "Could not save the record");
    }
}

export async function deleteDnsRecordAction(
    scope: DnsScopeRef,
    recordId: string
): Promise<{ error?: string }> {
    try {
        const resolved = await resolve(scope);
        await deleteZoneRecord(resolved.scope, String(recordId));
        await recordAudit({
            actorId: resolved.userId,
            orgId: resolved.orgId ?? undefined,
            action: "dns.record.delete",
            targetType: "dns-record",
            targetId: String(recordId)
        });
        return {};
    } catch (caught) {
        return failure(caught, "Could not remove the record");
    }
}

export async function dnsPropagationAction(
    scope: DnsScopeRef,
    recordId: string
): Promise<{ report?: PropagationReport; error?: string }> {
    try {
        const resolved = await resolve(scope);
        return { report: await recordPropagation(resolved.scope, String(recordId)) };
    } catch (caught) {
        return failure(caught, "Could not ask the resolvers");
    }
}
