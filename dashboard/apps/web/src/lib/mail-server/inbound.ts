/**
 * Rules on incoming mail: a message arriving at the server raises a Polaris
 * notification for whoever runs it.
 *
 * The engine posts its ingest events to `/api/mail-server/<id>/events`, signed
 * with the key setup gave it. The signature is checked before a byte of the body
 * is believed, then every event is read into the fields a rule can ask about and
 * matched. Three things stand between a rule and a flood: the guards in
 * `inboundRuleMatches` (spam, machine-sent mail, the server's own system
 * addresses - which is also what keeps Polaris's own notification mail, sent from
 * `polaris@`, from matching a rule and notifying about itself), and a per-rule
 * ceiling on how many notifications one window may raise.
 */

import { z } from "zod";
import { MailServerAccessError, unseal } from "./access";
import * as core from "@polaris/core";
import { recordAudit } from "@/lib/audit-service";
import { notify } from "@/lib/notifications/dispatch";
import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma, type MailInboundRule, type MailServer } from "@polaris/db";

/** The window the ceiling counts in, and how many notifications one rule may
 *  raise in it. */
const WINDOW_MS = 10 * 60_000;
const WINDOW_LIMIT = 20;

/** The most of a body the events route reads. */
export const MAX_EVENT_BODY = 1024 * 1024;

/**
 * Whether the signature header is the body signed with the key.
 *
 * The engine's documentation says the header carries a base64 HMAC of the body
 * and does not name the hash. The digest's length does: 32 bytes is SHA-256, 64
 * is SHA-512, 20 is SHA-1. Each is checked with the key, so which one it is
 * changes nothing about who can produce it.
 */
export function signatureMatches(raw: Buffer, header: string | null, secret: string): boolean {
    if (!header || !secret) return false;
    let given: Buffer;
    try {
        given = Buffer.from(header.trim(), "base64");
    } catch {
        return false;
    }
    const algorithm = given.length === 32 ? "sha256" : given.length === 64 ? "sha512" : given.length === 20 ? "sha1" : null;
    if (!algorithm) return false;
    const expected = createHmac(algorithm, secret).update(raw).digest();
    return expected.length === given.length && timingSafeEqual(expected, given);
}

/** The body the engine posts: a batch of events (see its webhook reference). */
export const webhookBodySchema = z.object({
    events: z
        .array(
            z.object({
                id: z.union([z.string(), z.number()]).optional(),
                createdAt: z.string().optional(),
                type: z.string().max(120),
                data: z.record(z.string(), z.unknown()).optional()
            })
        )
        .max(1000)
});

/** Whether the rule may notify again, and the window it will be counted in. */
export function withinCeiling(
    rule: Pick<MailInboundRule, "windowStartedAt" | "windowCount">,
    now: number
): { allowed: boolean; windowCount: number; fresh: boolean; last: boolean } {
    const fresh = !rule.windowStartedAt || now - rule.windowStartedAt.getTime() >= WINDOW_MS;
    const count = fresh ? 1 : rule.windowCount + 1;
    return { allowed: count <= WINDOW_LIMIT, windowCount: count, fresh, last: count === WINDOW_LIMIT };
}

async function fire(server: MailServer, rule: MailInboundRule, event: core.InboundEvent): Promise<void> {
    const now = Date.now();
    const ceiling = withinCeiling(rule, now);
    // The window starts at the first match in it; later ones only count.
    await prisma.mailInboundRule.update({
        where: { id: rule.id },
        data: {
            windowCount: ceiling.windowCount,
            ...(ceiling.fresh ? { windowStartedAt: new Date(now) } : {}),
            ...(ceiling.allowed ? { lastFiredAt: new Date(now) } : {})
        }
    });
    if (!ceiling.allowed) return;
    const to = event.to.length > 0 ? event.to.join(", ") : server.hostname;
    const body = [
        event.from ? `From ${event.from} to ${to}.` : `To ${to}.`,
        event.spam ? "The spam filter marked it as spam." : null,
        ceiling.last ? "This rule has matched often in the last ten minutes; further matches are not notified until the window ends." : null
    ]
        .filter(Boolean)
        .join(" ");
    await notify({
        userId: server.ownerId,
        event: "mailserver.inbound",
        title: `${rule.name}: mail arrived at ${server.hostname}`,
        body,
        href: `/apps/mail-server/${server.id}?tab=rules`,
        metadata: { serverId: server.id, ruleId: rule.id }
    });
}

/**
 * Take one signed batch from the engine. Answers the HTTP status to reply with:
 * 401 for a bad signature and for a server that is not here alike, so the route
 * cannot be used to learn which ids exist; 400 for a body that is not the
 * engine's; 200 otherwise.
 */
export async function receiveEvents(serverId: string, raw: Buffer, signature: string | null): Promise<number> {
    const server = await prisma.mailServer.findUnique({ where: { id: serverId } });
    if (!server) return 401;
    const secret = unseal(server.hookSecret, server.hookSecretNonce, server.hookSecretKeyId);
    if (!secret || !signatureMatches(raw, signature, secret)) return 401;
    let parsed: z.infer<typeof webhookBodySchema>;
    try {
        const body = webhookBodySchema.safeParse(JSON.parse(raw.toString("utf8")));
        if (!body.success) return 400;
        parsed = body.data;
    } catch {
        return 400;
    }
    const rules = await prisma.mailInboundRule.findMany({ where: { serverId, enabled: true }, orderBy: { createdAt: "asc" } });
    if (rules.length === 0) return 200;
    for (const entry of parsed.events) {
        const event = core.readInboundEvent(entry);
        if (!event) continue;
        for (const rule of rules) {
            if (!core.inboundRuleMatches(rule, event)) continue;
            await fire(server, rule, event);
            // Read the rule again so the next event in this batch sees the count.
            const fresh = await prisma.mailInboundRule.findUnique({ where: { id: rule.id } });
            if (fresh) Object.assign(rule, fresh);
        }
    }
    return 200;
}

// ---------------------------------------------------------------------------
// The rules themselves
// ---------------------------------------------------------------------------

export interface InboundRuleView {
    readonly id: string;
    readonly name: string;
    readonly recipient: string;
    readonly sender: string;
    readonly includeSpam: boolean;
    readonly enabled: boolean;
    readonly lastFiredAt: string | null;
}

function view(rule: MailInboundRule): InboundRuleView {
    return {
        id: rule.id,
        name: rule.name,
        recipient: rule.recipient,
        sender: rule.sender,
        includeSpam: rule.includeSpam,
        enabled: rule.enabled,
        lastFiredAt: rule.lastFiredAt?.toISOString() ?? null
    };
}

export async function listRules(server: MailServer): Promise<InboundRuleView[]> {
    const rows = await prisma.mailInboundRule.findMany({ where: { serverId: server.id }, orderBy: { createdAt: "asc" } });
    return rows.map(view);
}

/** The most rules one server holds. Each is asked about every message. */
const MAX_RULES = 50;

export async function createRule(actorId: string, server: MailServer, input: core.MailInboundRuleInput): Promise<InboundRuleView> {
    const count = await prisma.mailInboundRule.count({ where: { serverId: server.id } });
    if (count >= MAX_RULES) throw new MailServerAccessError(`A mail server holds at most ${MAX_RULES} rules.`);
    const row = await prisma.mailInboundRule.create({
        data: {
            serverId: server.id,
            name: input.name,
            recipient: input.recipient,
            sender: input.sender,
            includeSpam: input.includeSpam,
            enabled: input.enabled
        }
    });
    await recordAudit({ actorId, action: "mailserver.rule.create", targetType: "mail-server", targetId: server.id, orgId: server.orgId ?? undefined });
    return view(row);
}

export async function updateRule(
    actorId: string,
    server: MailServer,
    ruleId: string,
    input: core.MailInboundRuleInput
): Promise<void> {
    const updated = await prisma.mailInboundRule.updateMany({
        where: { id: ruleId, serverId: server.id },
        data: {
            name: input.name,
            recipient: input.recipient,
            sender: input.sender,
            includeSpam: input.includeSpam,
            enabled: input.enabled
        }
    });
    if (updated.count === 0) throw new MailServerAccessError("That rule is not on this mail server.");
    await recordAudit({ actorId, action: "mailserver.rule.update", targetType: "mail-server", targetId: server.id, orgId: server.orgId ?? undefined });
}

export async function deleteRule(actorId: string, server: MailServer, ruleId: string): Promise<void> {
    const removed = await prisma.mailInboundRule.deleteMany({ where: { id: ruleId, serverId: server.id } });
    if (removed.count === 0) throw new MailServerAccessError("That rule is not on this mail server.");
    await recordAudit({ actorId, action: "mailserver.rule.delete", targetType: "mail-server", targetId: server.id, orgId: server.orgId ?? undefined });
}
