/**
 * Everything an operator does to a running mail server: its domains, the
 * mailboxes and aliases on them, forwards, catch-all, and the mail waiting to go.
 *
 * None of it is stored in Polaris. The engine is where a mailbox exists, and a
 * copy kept here is the copy that disagrees with it after somebody changes a
 * password from a mail app - so every list is read from the engine, and every
 * change is made there and read back.
 *
 * Two mailboxes are Polaris's own and are shown but guarded: the administrator
 * account it manages the server with (hidden - deleting it would lock Polaris
 * out) and the mailbox it sends its own mail from (visible, not deletable).
 */

import { call } from "./stalwart";
import { reached } from "./steps";
import * as core from "@polaris/core";
import { endpointFor } from "./transport";
import type { MailServer } from "@polaris/db";
import { recordAudit } from "@/lib/audit-service";
import { ensureReportsMailbox } from "./dmarc-report";
import { passwordIsBreached } from "@/lib/pwned-passwords";
import { requireMailDomainStanding } from "./dns-standing";
import { adminCredentials, MailServerAccessError, type MailServerActor } from "./access";

/** A server Polaris can manage, with the endpoint and credential to do it. */
async function engine(server: MailServer) {
    if (!server.applicationId || !reached(server.step, "admin")) {
        throw new MailServerAccessError("This mail server is still being set up.");
    }
    return {
        endpoint: await endpointFor(server.applicationId),
        credentials: adminCredentials(server)
    };
}

async function run(server: MailServer, calls: readonly core.JmapCall[]): Promise<unknown> {
    const { endpoint, credentials } = await engine(server);
    return call(endpoint, credentials, calls);
}

async function audit(actorId: string, server: MailServer, action: string): Promise<void> {
    await recordAudit({
        actorId,
        action: `mailserver.${action}`,
        targetType: "mail-server",
        targetId: server.id,
        orgId: server.orgId ?? undefined
    });
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

export interface MailDomainView {
    readonly id: string;
    readonly name: string;
    readonly enabled: boolean;
    readonly catchAll: string | null;
    readonly primary: boolean;
    /** The zone the engine expects published, as it gave it. */
    readonly zoneFile: string;
}

export async function listDomains(server: MailServer): Promise<MailDomainView[]> {
    const rows = core.listOfAnswer<{
        id: string;
        name: string;
        isEnabled?: boolean;
        catchAllAddress?: string | null;
        dnsZoneFile?: string;
    }>(await run(server, core.domainListCalls()), "domains");
    return rows
        .map((row) => ({
            id: row.id,
            name: row.name,
            enabled: row.isEnabled !== false,
            catchAll: row.catchAllAddress ?? null,
            primary: row.name === server.primaryDomain,
            zoneFile: typeof row.dnsZoneFile === "string" ? row.dnsZoneFile : ""
        }))
        .sort(
            (left, right) =>
                Number(right.primary) - Number(left.primary) || left.name.localeCompare(right.name)
        );
}

export async function addDomain(
    actor: MailServerActor,
    server: MailServer,
    name: string
): Promise<string> {
    const existing = (await listDomains(server)).find((domain) => domain.name === name);
    if (existing) return existing.id;
    await requireMailDomainStanding(actor, server.orgId, name);
    const id = core.createdId(await run(server, [core.domainCreateCall(name)]), "domain", "domain");
    // Its DMARC reports go to the report mailbox's alias at the new domain.
    if (reached(server.step, "reports")) await ensureReportsMailbox(server);
    await audit(actor.id, server, "domain.add");
    return id;
}

export async function removeDomain(
    actorId: string,
    server: MailServer,
    domainId: string
): Promise<void> {
    const domain = (await listDomains(server)).find((one) => one.id === domainId);
    if (!domain) throw new MailServerAccessError("That domain is not on this mail server.");
    if (domain.primary) {
        throw new MailServerAccessError(
            "The server's first domain holds Polaris's own accounts and cannot be removed."
        );
    }
    const mailboxes = (await listMailboxes(server)).filter(
        (mailbox) => mailbox.domainId === domainId
    );
    if (mailboxes.length > 0) {
        throw new MailServerAccessError(
            `${domain.name} still has ${mailboxes.length} mailbox${mailboxes.length === 1 ? "" : "es"}. Remove them first.`
        );
    }
    // The report mailbox's alias there goes first, or the domain cannot.
    if (reached(server.step, "reports")) await ensureReportsMailbox(server, domainId);
    core.assertApplied(await run(server, [core.domainDestroyCall(domainId)]), "destroy", domainId);
    await audit(actorId, server, "domain.remove");
}

export async function setCatchAll(
    actorId: string,
    server: MailServer,
    domainId: string,
    address: string | null
): Promise<void> {
    core.assertApplied(
        await run(server, [core.domainCatchAllCall(domainId, address)]),
        "catchall",
        domainId
    );
    await audit(actorId, server, address ? "catchall.set" : "catchall.clear");
}

// ---------------------------------------------------------------------------
// Mailboxes and aliases
// ---------------------------------------------------------------------------

export interface MailboxView {
    readonly id: string;
    readonly address: string;
    readonly name: string;
    readonly domainId: string;
    readonly description: string;
    readonly quotaMb: number;
    readonly aliases: readonly { name: string; domainId: string }[];
    /** Polaris sends its own mail from this one; it cannot be removed here. */
    readonly polaris: boolean;
}

export async function listMailboxes(server: MailServer): Promise<MailboxView[]> {
    const [domains, rows] = await Promise.all([
        listDomains(server),
        run(server, core.accountListCalls()).then((response) =>
            core.listOfAnswer<{
                id: string;
                name: string;
                domainId: string;
                emailAddress?: string;
                description?: string;
                quotas?: Record<string, number>;
                aliases?: unknown;
                roles?: { "@type"?: string };
            }>(response, "accounts")
        )
    ]);
    const domainName = new Map(domains.map((domain) => [domain.id, domain.name]));
    const primaryId = domains.find((domain) => domain.primary)?.id;
    return rows
        .filter(
            (row) =>
                !(
                    row.domainId === primaryId &&
                    (row.name === core.MAIL_ADMIN_NAME || row.name === core.MAIL_REPORTS_NAME)
                )
        )
        .map((row) => ({
            id: row.id,
            address: row.emailAddress ?? `${row.name}@${domainName.get(row.domainId) ?? ""}`,
            name: row.name,
            domainId: row.domainId,
            description: row.description ?? "",
            quotaMb:
                typeof row.quotas?.maxDiskQuota === "number"
                    ? Math.round(row.quotas.maxDiskQuota / (1024 * 1024))
                    : 0,
            aliases: core
                .fromList<{ name?: string; domainId?: string }>(row.aliases)
                .flatMap((alias) =>
                    alias.name && alias.domainId
                        ? [{ name: alias.name, domainId: alias.domainId }]
                        : []
                ),
            polaris: row.name === core.MAIL_SENDER_NAME && row.domainId === primaryId
        }))
        .sort((left, right) => left.address.localeCompare(right.address));
}

/** Whether an address is one of Polaris's own: its administrator and sender on
 *  the first domain, and the report mailbox, which has an alias at every one. */
function reservedAt(domain: MailDomainView, localPart: string): boolean {
    if (localPart === core.MAIL_REPORTS_NAME) return true;
    return (
        domain.primary &&
        (localPart === core.MAIL_ADMIN_NAME || localPart === core.MAIL_SENDER_NAME)
    );
}

/**
 * Refuse a mailbox password that is the address back at itself, or one already
 * sitting in a breach list. The same checks run in the dialog as it is typed;
 * these are the ones that count. The breach lookup fails open.
 */
async function refuseWeakPassword(password: string, address: string): Promise<void> {
    if (core.passwordMatchesIdentity(password, [address]))
        throw new MailServerAccessError(core.MAILBOX_IDENTITY_PASSWORD_MESSAGE);
    if (await passwordIsBreached(password))
        throw new MailServerAccessError(core.BREACHED_PASSWORD_MESSAGE);
}

/** The mailbox, when it exists and is not one Polaris guards. */
async function ownMailbox(
    server: MailServer,
    accountId: string,
    allowPolaris = false
): Promise<MailboxView> {
    const mailbox = (await listMailboxes(server)).find((one) => one.id === accountId);
    if (!mailbox) throw new MailServerAccessError("That mailbox is not on this mail server.");
    if (mailbox.polaris && !allowPolaris) {
        throw new MailServerAccessError(
            "Polaris sends its own mail from this mailbox, so it is left as it is."
        );
    }
    return mailbox;
}

export async function createMailbox(
    actorId: string,
    server: MailServer,
    input: core.MailboxCreateInput
): Promise<{ id: string; address: string }> {
    const domain = (await listDomains(server)).find((one) => one.id === input.domainId);
    if (!domain) throw new MailServerAccessError("That domain is not on this mail server.");
    if (reservedAt(domain, input.localPart)) {
        throw new MailServerAccessError(
            `${input.localPart}@${domain.name} is Polaris's own. Choose another name.`
        );
    }
    await refuseWeakPassword(input.password, `${input.localPart}@${domain.name}`);
    const id = core.createdId(
        await run(server, [
            core.accountCreateCall({
                name: input.localPart,
                domainId: domain.id,
                password: input.password,
                quotaBytes: core.quotaBytes(input.quotaMb),
                ...(input.description ? { description: input.description } : {})
            })
        ]),
        "account",
        "account"
    );
    await audit(actorId, server, "mailbox.create");
    return { id, address: `${input.localPart}@${domain.name}` };
}

export async function setMailboxPassword(
    actorId: string,
    server: MailServer,
    accountId: string,
    password: string
): Promise<void> {
    const mailbox = await ownMailbox(server, accountId);
    await refuseWeakPassword(password, mailbox.address);
    core.assertApplied(
        await run(server, [core.accountPasswordCall(accountId, password)]),
        "password",
        accountId
    );
    await audit(actorId, server, "mailbox.password");
}

export async function setMailboxQuota(
    actorId: string,
    server: MailServer,
    accountId: string,
    quotaMb: number
): Promise<void> {
    await ownMailbox(server, accountId, true);
    core.assertApplied(
        await run(server, [core.accountQuotaCall(accountId, core.quotaBytes(quotaMb))]),
        "quota",
        accountId
    );
    await audit(actorId, server, "mailbox.quota");
}

export async function setMailboxAliases(
    actorId: string,
    server: MailServer,
    accountId: string,
    aliases: readonly { localPart: string; domainId: string }[]
): Promise<void> {
    await ownMailbox(server, accountId, true);
    const domains = new Map((await listDomains(server)).map((domain) => [domain.id, domain]));
    for (const alias of aliases) {
        const domain = domains.get(alias.domainId);
        if (!domain)
            throw new MailServerAccessError(
                "An alias names a domain that is not on this mail server."
            );
        if (reservedAt(domain, alias.localPart)) {
            throw new MailServerAccessError(
                `${alias.localPart}@${domain.name} is Polaris's own. Choose another name.`
            );
        }
    }
    core.assertApplied(
        await run(server, [
            core.accountAliasesCall(
                accountId,
                aliases.map((alias) => ({ name: alias.localPart, domainId: alias.domainId }))
            )
        ]),
        "aliases",
        accountId
    );
    await audit(actorId, server, "mailbox.aliases");
}

export async function deleteMailbox(
    actorId: string,
    server: MailServer,
    accountId: string
): Promise<void> {
    await ownMailbox(server, accountId);
    core.assertApplied(
        await run(server, [core.accountDestroyCall(accountId)]),
        "destroy",
        accountId
    );
    await audit(actorId, server, "mailbox.delete");
}

// ---------------------------------------------------------------------------
// Forwards
// ---------------------------------------------------------------------------

export interface ForwardView {
    readonly id: string;
    readonly address: string;
    readonly domainId: string;
    readonly recipients: readonly string[];
    readonly description: string;
}

export async function listForwards(server: MailServer): Promise<ForwardView[]> {
    const [domains, rows] = await Promise.all([
        listDomains(server),
        run(server, core.forwardListCalls()).then((response) =>
            core.listOfAnswer<{
                id: string;
                name: string;
                domainId: string;
                emailAddress?: string;
                recipients?: unknown;
                description?: string;
            }>(response, "forwards")
        )
    ]);
    const domainName = new Map(domains.map((domain) => [domain.id, domain.name]));
    return rows.map((row) => ({
        id: row.id,
        address: row.emailAddress ?? `${row.name}@${domainName.get(row.domainId) ?? ""}`,
        domainId: row.domainId,
        recipients: core.fromSet(row.recipients),
        description: row.description ?? ""
    }));
}

export async function createForward(
    actorId: string,
    server: MailServer,
    input: {
        domainId: string;
        localPart: string;
        recipients: readonly string[];
        description: string;
    }
): Promise<string> {
    const domain = (await listDomains(server)).find((one) => one.id === input.domainId);
    if (!domain) throw new MailServerAccessError("That domain is not on this mail server.");
    if (reservedAt(domain, input.localPart)) {
        throw new MailServerAccessError(
            `${input.localPart}@${domain.name} is Polaris's own. Choose another name.`
        );
    }
    const own = `${input.localPart}@${domain.name}`;
    // A forward to itself is a loop the engine would deliver until it gave up.
    if (input.recipients.some((recipient) => recipient === own)) {
        throw new MailServerAccessError("A forward cannot send mail back to its own address.");
    }
    const id = core.createdId(
        await run(server, [
            core.forwardCreateCall({
                name: input.localPart,
                domainId: domain.id,
                recipients: input.recipients,
                ...(input.description ? { description: input.description } : {})
            })
        ]),
        "forward",
        "forward"
    );
    await audit(actorId, server, "forward.create");
    return id;
}

export async function deleteForward(
    actorId: string,
    server: MailServer,
    forwardId: string
): Promise<void> {
    if (!(await listForwards(server)).some((forward) => forward.id === forwardId)) {
        throw new MailServerAccessError("That forward is not on this mail server.");
    }
    core.assertApplied(
        await run(server, [core.forwardDestroyCall(forwardId)]),
        "destroy",
        forwardId
    );
    await audit(actorId, server, "forward.delete");
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

/** How many messages are waiting to go out, or null when the engine will not say. */
export async function queuedMessages(server: MailServer): Promise<number | null> {
    try {
        const answer = core.answerOf(
            await run(server, [["x:QueuedMessage/query", { calculateTotal: true }, "queue"]]),
            "queue"
        );
        if (typeof answer.total === "number") return answer.total;
        return Array.isArray(answer.ids) ? answer.ids.length : null;
    } catch {
        return null;
    }
}
