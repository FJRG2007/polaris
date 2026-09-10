"use server";

/**
 * Everything the mail server screens ask for and change.
 *
 * Each action resolves the session, asks for `mailserver.manage`, validates its
 * input against the shared schema and resolves the server through `requireServer`
 * (which applies the owner or organization check) before it touches anything.
 * A refusal comes back as a sentence rather than a throw, so a dialog can show it
 * where it happened.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import * as dns from "@/lib/mail-server/dns";
import * as relay from "@/lib/mail-server/relay";
import * as setup from "@/lib/mail-server/setup";
import { recordAudit } from "@/lib/audit-service";
import * as health from "@/lib/mail-server/health";
import * as backup from "@/lib/mail-server/backup";
import * as ops from "@/lib/mail-server/operations";
import { addAccount } from "@/lib/mailbox/accounts";
import * as inbound from "@/lib/mail-server/inbound";
import { scopeOrgIdFor } from "@/lib/workspace-scope";
import * as dmarc from "@/lib/mail-server/dmarc-report";
import { requirePermission, sessionCan, type SessionUser } from "@/lib/session";
import { MailServerUnreachable } from "@/lib/mail-server/transport";
import { reached, SETUP_STEP_LABELS, SETUP_STEPS, type SetupStep } from "@/lib/mail-server/steps";
import { listServers, MailServerAccessError, requireServer, type MailServerActor } from "@/lib/mail-server/access";

type Result<T = object> = { error: string } | ({ error?: undefined } & T);

/** The sentence a failure is shown as. Only failures written for a reader are
 *  passed on; anything else is logged and said generically. */
function failed(error: unknown): { error: string } {
    if (
        error instanceof MailServerAccessError ||
        error instanceof setup.MailSetupRefusal ||
        error instanceof MailServerUnreachable ||
        error instanceof core.StalwartRefusal ||
        error instanceof dmarc.DmarcUploadError ||
        error instanceof core.DmarcReportError
    ) {
        return { error: error.message };
    }
    console.error("polaris: mail server action failed:", error);
    return { error: "That did not work. Try again in a moment." };
}

function invalid(error: z.ZodError): { error: string } {
    return { error: error.issues[0]?.message ?? "Those details are not valid" };
}

async function actor(): Promise<MailServerActor & { user: SessionUser }> {
    const user = await requirePermission("mailserver.manage");
    return { id: user.id, isAdmin: user.isAdmin, user };
}

const serverIdSchema = z.string().uuid();

async function server(id: unknown) {
    const who = await actor();
    const parsed = serverIdSchema.safeParse(id);
    if (!parsed.success) throw new MailServerAccessError();
    return { who, row: await requireServer(who, parsed.data) };
}

function refresh(serverId?: string): void {
    revalidatePath("/apps/mail-server");
    if (serverId) revalidatePath(`/apps/mail-server/${serverId}`);
}

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

export interface MailServerSummary {
    readonly id: string;
    readonly hostname: string;
    readonly primaryDomain: string;
    readonly status: string;
    readonly step: string;
    readonly error: string | null;
    readonly placement: string;
    readonly placementName: string;
    readonly createdAt: string;
}

/** The names of the machines servers run on, by placement. */
async function placementNames(placements: readonly string[]): Promise<Map<string, string>> {
    const ids = placements.filter((placement) => serverIdSchema.safeParse(placement).success);
    const hosts = ids.length > 0 ? await prisma.host.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    return new Map([["local", "This machine"], ...hosts.map((host) => [host.id, host.name] as [string, string])]);
}

export async function listServersAction(): Promise<Result<{ servers: MailServerSummary[] }>> {
    try {
        const who = await actor();
        const rows = await listServers(who, await scopeOrgIdFor(who.id));
        const names = await placementNames(rows.map((row) => row.placement));
        return {
            servers: rows.map((row) => ({
                id: row.id,
                hostname: row.hostname,
                primaryDomain: row.primaryDomain,
                status: row.status,
                step: row.step,
                error: row.error,
                placement: row.placement,
                placementName: names.get(row.placement) ?? "A server that is no longer connected",
                createdAt: row.createdAt.toISOString()
            }))
        };
    } catch (error) {
        return failed(error);
    }
}

/** Where a new server can run: this machine and every server the person enrolled. */
export async function listPlacementsAction(): Promise<{ id: string; name: string }[]> {
    const who = await actor();
    const hosts = await prisma.host.findMany({ where: { ownerId: who.id }, select: { id: true, name: true }, orderBy: { name: "asc" } });
    return [{ id: "local", name: "This machine" }, ...hosts];
}

export async function startSetupAction(input: unknown): Promise<Result<{ id: string }>> {
    const parsed = core.mailServerSetupSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const who = await actor();
        const row = await setup.startSetup(who, parsed.data, await scopeOrgIdFor(who.id));
        refresh();
        return { id: row.id };
    } catch (error) {
        return failed(error);
    }
}

export interface MailServerDetail extends MailServerSummary {
    readonly log: string;
    readonly running: boolean;
    readonly applicationId: string | null;
    readonly projectId: string | null;
    readonly steps: readonly { step: SetupStep; label: string; done: boolean }[];
}

export async function serverDetailAction(serverId: string): Promise<Result<{ server: MailServerDetail }>> {
    try {
        const { row } = await server(serverId);
        const names = await placementNames([row.placement]);
        const app = row.applicationId
            ? await prisma.application.findUnique({
                  where: { id: row.applicationId },
                  select: { environment: { select: { projectId: true } } }
              })
            : null;
        return {
            server: {
                id: row.id,
                hostname: row.hostname,
                primaryDomain: row.primaryDomain,
                status: row.status,
                step: row.step,
                error: row.error,
                placement: row.placement,
                placementName: names.get(row.placement) ?? "A server that is no longer connected",
                createdAt: row.createdAt.toISOString(),
                log: row.log,
                running: setup.isRunning(row.id),
                applicationId: row.applicationId,
                projectId: app?.environment.projectId ?? null,
                steps: SETUP_STEPS.filter((step) => step !== "done").map((step) => ({
                    step,
                    label: SETUP_STEP_LABELS[step],
                    done: reached(row.step, step)
                }))
            }
        };
    } catch (error) {
        return failed(error);
    }
}

const repairSchema = z.object({ serverId: z.string().uuid(), from: z.enum(SETUP_STEPS).nullable() });

/** Resume setup where it stopped, or run it again from a chosen step. */
export async function resumeSetupAction(input: unknown): Promise<Result> {
    const parsed = repairSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { who, row } = await server(parsed.data.serverId);
        await setup.resumeSetup(who, row, parsed.data.from ?? undefined);
        refresh(row.id);
        return {};
    } catch (error) {
        return failed(error);
    }
}

/**
 * Stop managing a server here. The Deploy service, its volumes and every
 * mailbox in them stay where they are - removing those is Deploy's delete, on
 * purpose, because it destroys mail that cannot be got back.
 */
export async function removeServerAction(serverId: string): Promise<Result> {
    try {
        const { who, row } = await server(serverId);
        if (setup.isRunning(row.id)) return { error: "Setup is still running. Wait for it to stop first." };
        await prisma.mailServer.delete({ where: { id: row.id } });
        await recordAudit({
            actorId: who.id,
            action: "mailserver.remove",
            targetType: "mail-server",
            targetId: row.id,
            orgId: row.orgId ?? undefined
        });
        refresh();
        return {};
    } catch (error) {
        return failed(error);
    }
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export async function healthAction(serverId: string): Promise<Result<{ health: health.MailHealth }>> {
    try {
        const { row } = await server(serverId);
        return { health: await health.mailHealth(row) };
    } catch (error) {
        return failed(error);
    }
}

export async function storedHealthAction(
    serverId: string
): Promise<Result<{ ports: health.PortReport | null; dns: ReturnType<typeof dns.storedDns> }>> {
    try {
        const { row } = await server(serverId);
        return { ports: health.storedPorts(row), dns: dns.storedDns(row) };
    } catch (error) {
        return failed(error);
    }
}

// ---------------------------------------------------------------------------
// Domains and DNS
// ---------------------------------------------------------------------------

export async function listDomainsAction(serverId: string): Promise<Result<{ domains: ops.MailDomainView[] }>> {
    try {
        const { row } = await server(serverId);
        return { domains: await ops.listDomains(row) };
    } catch (error) {
        return failed(error);
    }
}

export async function addDomainAction(input: unknown): Promise<Result<{ id: string }>> {
    const parsed = core.mailDomainSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { who, row } = await server(parsed.data.serverId);
        const id = await ops.addDomain(who.id, row, parsed.data.name);
        refresh(row.id);
        return { id };
    } catch (error) {
        return failed(error);
    }
}

const domainRefSchema = z.object({ serverId: z.string().uuid(), domainId: z.string().trim().min(1).max(64) });

export async function removeDomainAction(input: unknown): Promise<Result> {
    const parsed = domainRefSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { who, row } = await server(parsed.data.serverId);
        await ops.removeDomain(who.id, row, parsed.data.domainId);
        refresh(row.id);
        return {};
    } catch (error) {
        return failed(error);
    }
}

export async function setCatchAllAction(input: unknown): Promise<Result> {
    const parsed = core.mailCatchAllSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { who, row } = await server(parsed.data.serverId);
        await ops.setCatchAll(who.id, row, parsed.data.domainId, parsed.data.address);
        refresh(row.id);
        return {};
    } catch (error) {
        return failed(error);
    }
}

export async function scanDnsAction(serverId: string): Promise<Result<{ reports: dns.DomainDnsReport[]; at: string }>> {
    try {
        const { row } = await server(serverId);
        const reports = await dns.scanDns(row);
        return { reports, at: new Date().toISOString() };
    } catch (error) {
        return failed(error);
    }
}

export async function planDnsAction(input: unknown): Promise<Result<{ plan: dns.DnsPlan }>> {
    const parsed = domainRefSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { row } = await server(parsed.data.serverId);
        return { plan: await dns.planDns(row, parsed.data.domainId) };
    } catch (error) {
        return failed(error);
    }
}

const applySchema = domainRefSchema.extend({ replaceConflicts: z.boolean() });

export async function applyDnsAction(input: unknown): Promise<Result<{ results: dns.ApplyResult[] }>> {
    const parsed = applySchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { who, row } = await server(parsed.data.serverId);
        const results = await dns.applyDns(who.id, row, parsed.data.domainId, parsed.data.replaceConflicts);
        return { results };
    } catch (error) {
        return failed(error);
    }
}

// ---------------------------------------------------------------------------
// Mailboxes and forwards
// ---------------------------------------------------------------------------

export async function listMailboxesAction(
    serverId: string
): Promise<Result<{ mailboxes: ops.MailboxView[]; domains: ops.MailDomainView[] }>> {
    try {
        const { row } = await server(serverId);
        const [mailboxes, domains] = await Promise.all([ops.listMailboxes(row), ops.listDomains(row)]);
        return { mailboxes, domains };
    } catch (error) {
        return failed(error);
    }
}

/**
 * Create a mailbox, and - when asked - add it to the creator's own Mail app in
 * the same step, with the servers and the password already filled in. The
 * mailbox is made either way; a Mail app that could not connect yet (no
 * certificate, no DNS) is said as a warning, not a failure.
 */
export async function createMailboxAction(input: unknown): Promise<Result<{ id: string; address: string; warning: string | null }>> {
    const parsed = core.mailboxCreateSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { who, row } = await server(parsed.data.serverId);
        const created = await ops.createMailbox(who.id, row, parsed.data);
        let warning: string | null = null;
        if (parsed.data.addToMyMail) {
            if (!(await sessionCan(who.user, "mail.use"))) {
                warning = "The mailbox was created. Your account cannot use Mail, so it was not added there.";
            } else {
                const setupInput = core.mailAccountSetupSchema.safeParse({
                    address: created.address,
                    auth: "password",
                    password: parsed.data.password,
                    imap: { host: row.hostname, port: 993, security: "tls" },
                    smtp: { host: row.hostname, port: 465, security: "tls" }
                });
                if (!setupInput.success) {
                    warning = "The mailbox was created, but it could not be added to Mail.";
                } else {
                    await addAccount(who.id, setupInput.data, row.orgId).catch((error: unknown) => {
                        warning = `The mailbox was created. Mail could not connect to it yet${
                            error instanceof Error && error.message ? ` (${error.message})` : ""
                        }; add it from Mail once the server's DNS and certificate are in place.`;
                    });
                }
            }
        }
        refresh(row.id);
        return { ...created, warning };
    } catch (error) {
        return failed(error);
    }
}

export async function setMailboxPasswordAction(input: unknown): Promise<Result> {
    const parsed = core.mailboxPasswordSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { who, row } = await server(parsed.data.serverId);
        await ops.setMailboxPassword(who.id, row, parsed.data.accountId, parsed.data.password);
        return {};
    } catch (error) {
        return failed(error);
    }
}

export async function setMailboxQuotaAction(input: unknown): Promise<Result> {
    const parsed = core.mailboxQuotaSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { who, row } = await server(parsed.data.serverId);
        await ops.setMailboxQuota(who.id, row, parsed.data.accountId, parsed.data.quotaMb);
        refresh(row.id);
        return {};
    } catch (error) {
        return failed(error);
    }
}

export async function setMailboxAliasesAction(input: unknown): Promise<Result> {
    const parsed = core.mailAliasesSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { who, row } = await server(parsed.data.serverId);
        await ops.setMailboxAliases(who.id, row, parsed.data.accountId, parsed.data.aliases);
        refresh(row.id);
        return {};
    } catch (error) {
        return failed(error);
    }
}

const accountRefSchema = z.object({ serverId: z.string().uuid(), accountId: z.string().trim().min(1).max(64) });

export async function deleteMailboxAction(input: unknown): Promise<Result> {
    const parsed = accountRefSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { who, row } = await server(parsed.data.serverId);
        await ops.deleteMailbox(who.id, row, parsed.data.accountId);
        refresh(row.id);
        return {};
    } catch (error) {
        return failed(error);
    }
}

export async function listForwardsAction(
    serverId: string
): Promise<Result<{ forwards: ops.ForwardView[]; domains: ops.MailDomainView[] }>> {
    try {
        const { row } = await server(serverId);
        const [forwards, domains] = await Promise.all([ops.listForwards(row), ops.listDomains(row)]);
        return { forwards, domains };
    } catch (error) {
        return failed(error);
    }
}

export async function createForwardAction(input: unknown): Promise<Result<{ id: string }>> {
    const parsed = core.mailForwardSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { who, row } = await server(parsed.data.serverId);
        const id = await ops.createForward(who.id, row, parsed.data);
        refresh(row.id);
        return { id };
    } catch (error) {
        return failed(error);
    }
}

const forwardRefSchema = z.object({ serverId: z.string().uuid(), forwardId: z.string().trim().min(1).max(64) });

export async function deleteForwardAction(input: unknown): Promise<Result> {
    const parsed = forwardRefSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { who, row } = await server(parsed.data.serverId);
        await ops.deleteForward(who.id, row, parsed.data.forwardId);
        refresh(row.id);
        return {};
    } catch (error) {
        return failed(error);
    }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export async function relayAction(serverId: string): Promise<Result<{ relay: relay.RelaySetting | null }>> {
    try {
        const { row } = await server(serverId);
        return { relay: relay.storedRelay(row) };
    } catch (error) {
        return failed(error);
    }
}

export async function setRelayAction(input: unknown): Promise<Result> {
    const parsed = core.mailRelaySchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { who, row } = await server(parsed.data.serverId);
        await relay.setRelay(who.id, row, parsed.data);
        refresh(row.id);
        return {};
    } catch (error) {
        return failed(error);
    }
}

// ---------------------------------------------------------------------------
// Rules on incoming mail
// ---------------------------------------------------------------------------

export async function listRulesAction(serverId: string): Promise<Result<{ rules: inbound.InboundRuleView[] }>> {
    try {
        const { row } = await server(serverId);
        return { rules: await inbound.listRules(row) };
    } catch (error) {
        return failed(error);
    }
}

export async function createRuleAction(input: unknown): Promise<Result<{ rule: inbound.InboundRuleView }>> {
    const parsed = core.mailInboundRuleSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { who, row } = await server(parsed.data.serverId);
        const rule = await inbound.createRule(who.id, row, parsed.data);
        return { rule };
    } catch (error) {
        return failed(error);
    }
}

const ruleUpdateSchema = core.mailInboundRuleSchema.extend({ ruleId: z.string().uuid() });

export async function updateRuleAction(input: unknown): Promise<Result> {
    const parsed = ruleUpdateSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { who, row } = await server(parsed.data.serverId);
        await inbound.updateRule(who.id, row, parsed.data.ruleId, parsed.data);
        return {};
    } catch (error) {
        return failed(error);
    }
}

const ruleRefSchema = z.object({ serverId: z.string().uuid(), ruleId: z.string().uuid() });

export async function deleteRuleAction(input: unknown): Promise<Result> {
    const parsed = ruleRefSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { who, row } = await server(parsed.data.serverId);
        await inbound.deleteRule(who.id, row, parsed.data.ruleId);
        return {};
    } catch (error) {
        return failed(error);
    }
}

// ---------------------------------------------------------------------------
// DMARC reports and backups
// ---------------------------------------------------------------------------

const rangeSchema = z.object({ serverId: z.string().uuid(), days: z.union([z.literal(7), z.literal(30), z.literal(90)]) });

export async function dmarcAction(input: unknown): Promise<Result<{ overview: dmarc.DmarcOverview }>> {
    const parsed = rangeSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
        const { row } = await server(parsed.data.serverId);
        return { overview: await dmarc.dmarcOverview(row, parsed.data.days) };
    } catch (error) {
        return failed(error);
    }
}

/** Read the report mailbox now rather than at the next scheduled pass. */
export async function collectReportsAction(serverId: string): Promise<Result<{ filed: number; messages: number }>> {
    try {
        const { row } = await server(serverId);
        const result = await dmarc.collectReports(row);
        const fresh = await prisma.mailServer.findUnique({ where: { id: row.id }, select: { reportsError: true } });
        if (fresh?.reportsError) return { error: fresh.reportsError };
        return { filed: result.filed, messages: result.messages };
    } catch (error) {
        return failed(error);
    }
}

export async function backupsAction(serverId: string): Promise<Result<{ volumes: backup.MailBackupView[] }>> {
    try {
        const { row } = await server(serverId);
        return { volumes: await backup.mailBackups(row) };
    } catch (error) {
        return failed(error);
    }
}

export async function protectAction(serverId: string): Promise<Result<{ count: number }>> {
    try {
        const { who, row } = await server(serverId);
        const count = await backup.protectMailServer(who.id, row);
        return { count };
    } catch (error) {
        return failed(error);
    }
}
