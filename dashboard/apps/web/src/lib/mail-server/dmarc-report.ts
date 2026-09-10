/**
 * DMARC aggregate reports: where they arrive, and turning them into rows.
 *
 * Every large receiver mails a daily report to the address in a domain's DMARC
 * `rua`. The engine writes that address from each domain's report address, so
 * setup points every domain at `dmarc-reports@<that domain>` - one mailbox of
 * Polaris's own on the first domain, with an alias at each of the others. A
 * report address at the same domain needs no authorization record, which one at
 * another domain would (RFC 7489 section 7.1).
 *
 * Polaris then reads that mailbox over JMAP with its own credential, unpacks
 * each attachment (gzip, zip or bare XML - receivers use all three), and files
 * the reports about domains this server holds. Messages are marked seen once
 * handled, so a run picks up where the last one stopped and the mailbox stays
 * readable as it is. An operator with a report in hand can upload it instead:
 * the same unpacking, from a file.
 */

import JSZip from "jszip";
import { reached } from "./steps";
import * as core from "@polaris/core";
import { gunzipSync } from "node:zlib";
import { simpleParser } from "mailparser";
import { randomBytes } from "node:crypto";
import { endpointFor } from "./transport";
import { XMLParser } from "fast-xml-parser";
import { prisma, type MailServer } from "@polaris/db";
import { adminCredentials, MailServerAccessError, seal, unseal } from "./access";
import { call, download, mailSession, type StalwartCredentials } from "./stalwart";

/** The most one report unpacks to. The largest real ones are a few megabytes. */
const MAX_XML_BYTES = 20 * 1024 * 1024;

/** The largest attachment downloaded. Reports arrive compressed and small. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Messages handled per run; a backlog is worked through over several runs. */
const BATCH = 25;

/** The quota of the report mailbox. Reports are kept here as well as filed. */
const REPORTS_QUOTA_BYTES = 512 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Unpacking
// ---------------------------------------------------------------------------

/** Why a file is not a report Polaris can read, as a sentence. */
export class DmarcUploadError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "DmarcUploadError";
    }
}

function isGzip(bytes: Uint8Array): boolean {
    return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function isZip(bytes: Uint8Array): boolean {
    return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function looksLikeXml(bytes: Uint8Array): boolean {
    // trimStart also drops a byte-order mark.
    const head = Buffer.from(bytes.subarray(0, 256)).toString("utf8").trimStart();
    return head.startsWith("<");
}

/** One zip entry inflated, stopping the moment it passes the bound - the size
 *  a zip declares for an entry is only a claim. */
function inflateEntry(entry: JSZip.JSZipObject): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const stream = entry.nodeStream("nodebuffer");
        stream
            .on("data", (chunk: Buffer) => {
                size += chunk.length;
                if (size > MAX_XML_BYTES) {
                    stream.pause();
                    stream.removeAllListeners("data");
                    reject(new DmarcUploadError("That report unpacks to more than any real report does."));
                    return;
                }
                chunks.push(chunk);
            })
            .on("error", (error: Error) => reject(error))
            .on("end", () => resolve(Buffer.concat(chunks)));
    });
}

/**
 * The XML documents inside one attachment: gunzipped, unzipped, or as it is.
 * Anything else answers an empty list - a mailbox receives more than reports.
 */
export async function unpackAttachment(bytes: Uint8Array): Promise<string[]> {
    if (isGzip(bytes)) {
        let inflated: Buffer;
        try {
            inflated = gunzipSync(bytes, { maxOutputLength: MAX_XML_BYTES });
        } catch {
            throw new DmarcUploadError("That compressed report is damaged, or unpacks to more than any real report does.");
        }
        return looksLikeXml(inflated) ? [inflated.toString("utf8")] : [];
    }
    if (isZip(bytes)) {
        let zip: JSZip;
        try {
            zip = await JSZip.loadAsync(bytes);
        } catch {
            throw new DmarcUploadError("That zip file is damaged.");
        }
        const documents: string[] = [];
        let total = 0;
        for (const entry of Object.values(zip.files)) {
            if (entry.dir || !entry.name.toLowerCase().endsWith(".xml")) continue;
            const inflated = await inflateEntry(entry);
            total += inflated.length;
            if (total > MAX_XML_BYTES) throw new DmarcUploadError("That zip file unpacks to more than any real report does.");
            documents.push(inflated.toString("utf8"));
        }
        return documents;
    }
    return looksLikeXml(bytes) ? [Buffer.from(bytes).toString("utf8")] : [];
}

const parser = new XMLParser({
    ignoreAttributes: true,
    removeNSPrefix: true,
    // Values stay text: a report id of twenty digits is not a number.
    parseTagValue: false,
    trimValues: true
});

/** Read one XML document as a report. */
export function parseReportXml(xml: string): core.DmarcReport {
    // A report never carries a document type, and one that does is somebody
    // reaching for entity expansion.
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new core.DmarcReportError("That file declares a document type, which no report does.");
    let document: unknown;
    try {
        document = parser.parse(xml);
    } catch {
        throw new core.DmarcReportError("That file is not well-formed XML.");
    }
    return core.normalizeDmarcReport(document);
}

/**
 * Every report in an uploaded file: a report as receivers send it (.xml, .xml.gz,
 * .zip), or the whole message it came in (.eml).
 */
export async function reportsInUpload(bytes: Uint8Array): Promise<core.DmarcReport[]> {
    let documents = await unpackAttachment(bytes);
    if (documents.length === 0) {
        // Not a report on its own: read it as a message and look in its parts.
        const message = await simpleParser(Buffer.from(bytes)).catch(() => null);
        documents = [];
        for (const attachment of message?.attachments ?? []) {
            documents.push(...(await unpackAttachment(attachment.content)));
        }
    }
    if (documents.length === 0) throw new DmarcUploadError("No DMARC report was found in that file.");
    return documents.map(parseReportXml);
}

// ---------------------------------------------------------------------------
// Filing
// ---------------------------------------------------------------------------

/**
 * File reports for one server. A report about a domain the server does not hold
 * is not filed - a report address is an address anybody can write to - and the
 * same report twice is one row.
 */
export async function fileReports(
    serverId: string,
    domains: ReadonlySet<string>,
    reports: readonly core.DmarcReport[]
): Promise<{ filed: number; ignored: number }> {
    let filed = 0;
    let ignored = 0;
    for (const report of reports) {
        if (!domains.has(report.domain)) {
            ignored += 1;
            continue;
        }
        const messages = report.rows.reduce((sum, row) => sum + row.count, 0);
        const failed = report.rows.filter((row) => !core.rowPasses(row)).reduce((sum, row) => sum + row.count, 0);
        const created = await prisma.mailDmarcReport.createMany({
            data: [
                {
                    serverId,
                    orgName: report.orgName.slice(0, 200),
                    reportId: report.reportId.slice(0, 200),
                    domain: report.domain,
                    beginAt: report.begin,
                    endAt: report.end,
                    rows: report.rows as unknown as object,
                    messages,
                    failed
                }
            ],
            skipDuplicates: true
        });
        filed += created.count;
    }
    return { filed, ignored };
}

/** The domains a server holds, read from the engine. */
async function serverDomains(server: MailServer): Promise<{ id: string; name: string }[]> {
    if (!server.applicationId) return [];
    const endpoint = await endpointFor(server.applicationId);
    return core.listOfAnswer<{ id: string; name: string }>(
        await call(endpoint, adminCredentials(server), core.domainListCalls()),
        "domains"
    );
}

/** A filed report, back in the shape the summary reads. */
function storedReport(row: {
    orgName: string;
    reportId: string;
    domain: string;
    beginAt: Date;
    endAt: Date;
    rows: unknown;
}): core.DmarcReport {
    // Rows were checked when filed; read back defensively all the same, since a
    // stored value outlives the code that wrote it.
    const rows = Array.isArray(row.rows) ? (row.rows as core.DmarcRow[]).filter((item) => typeof item?.sourceIp === "string") : [];
    return {
        orgName: row.orgName,
        reportId: row.reportId,
        email: "",
        begin: row.beginAt,
        end: row.endAt,
        domain: row.domain,
        policy: { p: "", sp: "", pct: 100 },
        rows: rows.map((item) => ({
            ...item,
            count: typeof item.count === "number" ? item.count : 0,
            authDkim: Array.isArray(item.authDkim) ? item.authDkim : [],
            authSpf: Array.isArray(item.authSpf) ? item.authSpf : []
        }))
    };
}

export interface DmarcOverview {
    readonly sources: readonly core.DmarcSource[];
    readonly reports: readonly {
        id: string;
        orgName: string;
        domain: string;
        beginAt: string;
        endAt: string;
        messages: number;
        failed: number;
    }[];
    readonly checkedAt: string | null;
    readonly error: string | null;
    readonly address: string;
}

/** What the Reports screen shows: every sending address over the range, worst
 *  first, and the reports it was read from. */
export async function dmarcOverview(server: MailServer, sinceDays: number): Promise<DmarcOverview> {
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
    const rows = await prisma.mailDmarcReport.findMany({
        where: { serverId: server.id, endAt: { gte: since } },
        orderBy: { endAt: "desc" },
        take: 2000
    });
    return {
        sources: core.summarizeDmarcSources(rows.map(storedReport)),
        reports: rows.slice(0, 200).map((row) => ({
            id: row.id,
            orgName: row.orgName,
            domain: row.domain,
            beginAt: row.beginAt.toISOString(),
            endAt: row.endAt.toISOString(),
            messages: row.messages,
            failed: row.failed
        })),
        checkedAt: server.reportsCheckedAt?.toISOString() ?? null,
        error: server.reportsError,
        address: `${core.MAIL_REPORTS_NAME}@${server.primaryDomain}`
    };
}

/** File an uploaded report for a server. */
export async function uploadReport(server: MailServer, bytes: Uint8Array): Promise<{ filed: number; ignored: number }> {
    const reports = await reportsInUpload(bytes);
    const domains = new Set((await serverDomains(server)).map((domain) => domain.name));
    return fileReports(server.id, domains, reports);
}

// ---------------------------------------------------------------------------
// The mailbox
// ---------------------------------------------------------------------------

function reportsCredentials(server: MailServer): StalwartCredentials | null {
    const password = unseal(server.reportsSecret, server.reportsSecretNonce, server.reportsSecretKeyId);
    return password ? { username: `${core.MAIL_REPORTS_NAME}@${server.primaryDomain}`, password } : null;
}

/**
 * The report mailbox, made to be as it should: the account on the first domain
 * with the password Polaris holds, an alias at every other domain, and every
 * domain's report address pointed at its own alias. Safe to run again, and run
 * whenever a domain is added or removed - `without` is a domain about to go,
 * whose alias has to leave first or the engine will not let it go.
 */
export async function ensureReportsMailbox(server: MailServer, without?: string): Promise<void> {
    if (!server.applicationId || !reached(server.step, "admin")) {
        throw new MailServerAccessError("This mail server is still being set up.");
    }
    const endpoint = await endpointFor(server.applicationId);
    const credentials = adminCredentials(server);
    const domains = core
        .listOfAnswer<{ id: string; name: string }>(await call(endpoint, credentials, core.domainListCalls()), "domains")
        .filter((domain) => domain.id !== without);
    const primary = domains.find((domain) => domain.name === server.primaryDomain);
    if (!primary) throw new MailServerAccessError(`${server.primaryDomain} is missing from the mail server. Repair it from the start.`);

    let password = unseal(server.reportsSecret, server.reportsSecretNonce, server.reportsSecretKeyId);
    if (!password) {
        password = randomBytes(24).toString("base64url");
        const sealed = seal(password);
        await prisma.mailServer.update({
            where: { id: server.id },
            data: { reportsSecret: sealed.ciphertext, reportsSecretNonce: sealed.nonce, reportsSecretKeyId: sealed.keyId }
        });
    }

    const accounts = core.listOfAnswer<{ id: string; name: string; domainId: string }>(
        await call(endpoint, credentials, core.accountListCalls()),
        "accounts"
    );
    let accountId = accounts.find((account) => account.name === core.MAIL_REPORTS_NAME && account.domainId === primary.id)?.id;
    if (accountId) {
        core.assertApplied(await call(endpoint, credentials, [core.accountPasswordCall(accountId, password)]), "password", accountId);
    } else {
        accountId = core.createdId(
            await call(endpoint, credentials, [
                core.accountCreateCall({
                    name: core.MAIL_REPORTS_NAME,
                    domainId: primary.id,
                    password,
                    quotaBytes: REPORTS_QUOTA_BYTES,
                    description: "DMARC reports about this server's domains arrive here; Polaris reads and files them."
                })
            ]),
            "account",
            "account"
        );
    }
    const others = domains.filter((domain) => domain.id !== primary.id);
    core.assertApplied(
        await call(endpoint, credentials, [
            core.accountAliasesCall(
                accountId,
                others.map((domain) => ({ name: core.MAIL_REPORTS_NAME, domainId: domain.id }))
            )
        ]),
        "aliases",
        accountId
    );
    for (const domain of domains) {
        core.assertApplied(
            await call(endpoint, credentials, [
                core.domainReportAddressCall(domain.id, `${core.MAIL_REPORTS_NAME}@${domain.name}`)
            ]),
            "reports",
            domain.id
        );
    }
}

/**
 * Read the report mailbox once: the oldest unread messages, every report in
 * them filed, each message marked seen. Records when it ran and what stopped
 * it, for the screen.
 */
export async function collectReports(server: MailServer): Promise<{ filed: number; ignored: number; messages: number }> {
    const credentials = reportsCredentials(server);
    if (!server.applicationId || !reached(server.step, "reports") || !credentials) {
        return { filed: 0, ignored: 0, messages: 0 };
    }
    try {
        const endpoint = await endpointFor(server.applicationId);
        const session = await mailSession(endpoint, credentials);
        const response = await call(
            endpoint,
            credentials,
            core.unreadWithAttachmentsCalls(session.accountId, BATCH),
            core.jmapMailRequest
        );
        const messages = core.listOfAnswer<{
            id: string;
            attachments?: { blobId?: string; type?: string; name?: string | null; size?: number }[] | null;
        }>(response, "messages");
        const domains = new Set((await serverDomains(server)).map((domain) => domain.name));
        let filed = 0;
        let ignored = 0;
        for (const message of messages) {
            const reports: core.DmarcReport[] = [];
            for (const attachment of message.attachments ?? []) {
                if (!attachment.blobId || (attachment.size ?? 0) > MAX_ATTACHMENT_BYTES) continue;
                const bytes = await download(
                    endpoint,
                    credentials,
                    core.downloadPath(session.downloadUrl, {
                        accountId: session.accountId,
                        blobId: attachment.blobId,
                        type: attachment.type ?? "application/octet-stream",
                        name: attachment.name ?? "report"
                    })
                );
                // A part that is not a report, or a report that does not read,
                // is passed over: the message is still marked seen, so one bad
                // message cannot stop every later one from being read.
                const documents = await unpackAttachment(bytes).catch(() => [] as string[]);
                for (const xml of documents) {
                    try {
                        reports.push(parseReportXml(xml));
                    } catch {
                        ignored += 1;
                    }
                }
            }
            const result = await fileReports(server.id, domains, reports);
            filed += result.filed;
            ignored += result.ignored;
        }
        if (messages.length > 0) {
            core.answerOf(
                await call(
                    endpoint,
                    credentials,
                    [core.markSeenCall(session.accountId, messages.map((message) => message.id))],
                    core.jmapMailRequest
                ),
                "seen"
            );
        }
        await prisma.mailServer.update({ where: { id: server.id }, data: { reportsCheckedAt: new Date(), reportsError: null } });
        return { filed, ignored, messages: messages.length };
    } catch (error) {
        const said =
            error instanceof core.StalwartRefusal || error instanceof MailServerAccessError
                ? error.message
                : "The report mailbox could not be read. It is tried again on the next run.";
        if (!(error instanceof core.StalwartRefusal)) console.error("polaris: reading the DMARC report mailbox failed:", error);
        await prisma.mailServer.update({ where: { id: server.id }, data: { reportsCheckedAt: new Date(), reportsError: said } });
        return { filed: 0, ignored: 0, messages: 0 };
    }
}

/** The scheduled read of every ready server's report mailbox. */
export async function collectAllReports(): Promise<{ servers: number; filed: number }> {
    const servers = await prisma.mailServer.findMany({ where: { status: { in: ["ready", "down"] } } });
    let filed = 0;
    for (const server of servers) {
        filed += (await collectReports(server)).filed;
    }
    return { servers: servers.length, filed };
}
