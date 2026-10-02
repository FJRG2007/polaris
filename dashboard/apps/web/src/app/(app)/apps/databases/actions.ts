"use server";

/**
 * Everything the database browser calls.
 *
 * Two gates on every one of them, in this order: `deploy.read` says the app
 * exists for this account at all, and the connection has to be one this account
 * saved - which is what `addressOf` proves before it hands back an address. A
 * connection id in a request is a request, not a permission.
 *
 * Failures come back as `{ error }` rather than thrown, because every caller is a
 * panel with somewhere to put the sentence, and an engine's own error is usually
 * the most useful thing anybody can be told: "relation does not exist" is an
 * answer, and "something went wrong" is not. What is never passed on is the
 * address or the credential - those stay on this side.
 */

import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import * as browser from "@/lib/data/browser";
import { listHosts } from "@/lib/host-service";
import { requirePermission } from "@/lib/session";
import * as connections from "@/lib/data/connections";
import { engineStats, type DatabaseStats } from "@/lib/data/stats";
import { databaseInsights, type DatabaseInsights } from "@/lib/data/insights";
import { DataRequestError, ReadOnlyError } from "@/lib/data/driver";
import { getTranslations } from "@/lib/i18n/request";
import { rateLimit } from "@/lib/rate-limit-service";
import { withDriver } from "@/lib/data/open";
import { readPrivateKey, SshKeyError } from "@/lib/data/ssh-key";
import { dataText } from "@/lib/data/words";
import type {
    DataColumn,
    DataNamespace,
    DataPage,
    DataRelation,
    QueryResult
} from "@/lib/data/driver";

const PATH = "/apps/databases";

/** The caller, or a refusal. Every action starts here. */
async function actor(): Promise<{ id: string }> {
    const user = await requirePermission("deploy.read");
    return { id: user.id };
}

/**
 * Turn a refusal into a sentence, and a fault into a line in the log.
 *
 * Only the refusals this app writes for a reader are shown. Anything else is a
 * fault, and a fault talking to a database describes that database out loud -
 * table names, drivers, connection strings - to whoever happens to be looking.
 * The real one goes to the log, whole, where it is of use.
 */
async function guard<T>(run: () => Promise<T>): Promise<{ value?: T; error?: string }> {
    try {
        return { value: await run() };
    } catch (caught) {
        const spoken =
            caught instanceof connections.DataConnectionError ||
            caught instanceof ReadOnlyError ||
            caught instanceof DataRequestError;
        const t = await getTranslations("databases");
        if (spoken) return { error: dataText(t, (caught as Error).message) };
        console.error("databases: an action failed", caught);
        return { error: t("refusals.generic") };
    }
}

/** Everything this account can open: what it saved, what Polaris runs for it,
 *  and Polaris' own for whoever runs the instance. */
export async function listDatabasesAction(): Promise<{
    connections?: connections.DataConnectionView[];
    error?: string;
}> {
    const me = await actor();
    const result = await guard(() => connections.listOpenable(me.id));
    return result.error ? { error: result.error } : { connections: result.value };
}

/** The databases Polaris runs that this account can point a connection at. */
export async function listManagedAction(): Promise<{
    databases?: connections.ManagedOption[];
    error?: string;
}> {
    const me = await actor();
    const result = await guard(() => connections.listManagedOptions(me.id));
    return result.error ? { error: result.error } : { databases: result.value };
}

export async function saveConnectionAction(
    input: connections.SaveConnectionInput
): Promise<{ id?: string; error?: string }> {
    const me = await actor();
    const refused = await dialAllowed(me.id);
    if (refused) return { error: refused };
    const result = await guard(() => connections.saveConnection(me.id, input));
    if (result.error) return { error: result.error };
    revalidatePath(PATH);
    return { id: result.value };
}

export async function deleteConnectionAction(id: string): Promise<{ error?: string }> {
    const me = await actor();
    const result = await guard(() => connections.deleteConnection(me.id, String(id)));
    if (result.error) return { error: result.error };
    revalidatePath(PATH);
    return {};
}

/**
 * How many connection attempts one account may make a minute, between the
 * test button, a save (which signs in to the SSH server) and the checks of a
 * changed key or certificate. Each one dials an address somebody typed with a
 * credential somebody typed, so without a ceiling the form is a way to guess
 * passwords against somebody's server - or against anybody's, through Polaris.
 */
const DIAL_LIMIT = 20;
const DIAL_WINDOW_MS = 60_000;

/** One attempt counted against the account, or the refusal to give. */
async function dialAllowed(userId: string): Promise<string | null> {
    const throttle = await rateLimit(`databases-dial:${userId}`, DIAL_LIMIT, DIAL_WINDOW_MS);
    if (throttle.ok) return null;
    const t = await getTranslations("databases");
    return t("refusals.tooManyAttempts", { seconds: Math.ceil(throttle.retryAfterMs / 1000) });
}

/** Open it and say what answered, which is the only test worth running. */
export async function testConnectionAction(
    id: string
): Promise<{ version?: string; error?: string }> {
    const me = await actor();
    const refused = await dialAllowed(me.id);
    if (refused) return { error: refused };
    const result = await guard(() => browser.version(me.id, String(id)));
    return result.error ? { error: result.error } : { version: result.value };
}

/**
 * Open what the form describes, without saving it, and say what answered. The
 * same checks a save makes, and the same rule about which stored secrets an
 * edit keeps - a stored password is only sent to the address it was saved for.
 */
export async function testDraftAction(
    input: connections.SaveConnectionInput
): Promise<{ version?: string; error?: string }> {
    const me = await actor();
    const refused = await dialAllowed(me.id);
    if (refused) return { error: refused };
    const result = await guard(() =>
        connections.testDraft(me.id, input, (address) =>
            withDriver(address, (driver) => driver.version())
        )
    );
    return result.error ? { error: result.error } : { version: result.value };
}

/**
 * Read a private key the form was given, with ssh2's own parser, and say what
 * it is - or why it cannot be used: a public key, a locked one, a wrong
 * passphrase. Nothing is stored and the key is not sent back, only its type and
 * fingerprint. Counted separately from dialling, since it costs this server
 * CPU (an encrypted key's KDF) rather than anybody else a connection.
 */
export async function inspectKeyAction(
    key: string,
    passphrase: string | null
): Promise<{ type?: string; fingerprint?: string; error?: string }> {
    const me = await actor();
    const text = typeof key === "string" ? key : "";
    const phrase = typeof passphrase === "string" && passphrase !== "" ? passphrase : null;
    const t = await getTranslations("databases");
    if (text.length > 16_384) return { error: dataText(t, "That file is too large.") };
    const throttle = await rateLimit(`databases-key:${me.id}`, 30, DIAL_WINDOW_MS);
    if (!throttle.ok) {
        return {
            error: t("refusals.tooManyAttempts", {
                seconds: Math.ceil(throttle.retryAfterMs / 1000)
            })
        };
    }
    try {
        const read = readPrivateKey(text, phrase);
        return { type: read.type, fingerprint: read.fingerprint };
    } catch (error) {
        if (error instanceof SshKeyError) return { error: dataText(t, error.message) };
        console.error("databases: a private key could not be read", error);
        return { error: t("refusals.generic") };
    }
}

/** The SSH key the server presents now, next to the pinned one. Read without
 *  signing in. */
export async function checkHostKeyAction(
    id: string
): Promise<{ check?: connections.HostKeyCheck; error?: string }> {
    const me = await actor();
    const refused = await dialAllowed(me.id);
    if (refused) return { error: refused };
    const result = await guard(() => connections.checkHostKey(me.id, String(id)));
    return result.error ? { error: result.error } : { check: result.value };
}

/** Pin the key the reader was shown, if it is still the one presented. */
export async function trustHostKeyAction(
    id: string,
    fingerprint: string
): Promise<{ fingerprint?: string; error?: string }> {
    const me = await actor();
    const refused = await dialAllowed(me.id);
    if (refused) return { error: refused };
    const result = await guard(() =>
        connections.trustHostKey(me.id, String(id), String(fingerprint))
    );
    if (result.error) return { error: result.error };
    revalidatePath(PATH);
    return { fingerprint: result.value };
}

/** The certificate the server presents now, next to the trusted one. */
export async function checkCertificateAction(
    id: string
): Promise<{ check?: connections.CertificateCheck; error?: string }> {
    const me = await actor();
    const refused = await dialAllowed(me.id);
    if (refused) return { error: refused };
    const result = await guard(() => connections.checkCertificate(me.id, String(id)));
    return result.error ? { error: result.error } : { check: result.value };
}

/** Trust the certificate the reader was shown, if it is still the one presented. */
export async function trustCertificateAction(
    id: string,
    fingerprint: string
): Promise<{ error?: string }> {
    const me = await actor();
    const refused = await dialAllowed(me.id);
    if (refused) return { error: refused };
    const result = await guard(() =>
        connections.trustCertificate(me.id, String(id), String(fingerprint))
    );
    if (result.error) return { error: result.error };
    revalidatePath(PATH);
    return {};
}

export async function browseAction(
    id: string,
    namespace: string | null
): Promise<{
    shape?: string;
    namespaces?: DataNamespace[];
    relations?: DataRelation[];
    /** The schema the relations came from, so the screen names the one it is
     *  showing rather than choosing again and disagreeing. */
    namespace?: string | null;
    error?: string;
}> {
    const me = await actor();
    const result = await guard(() => browser.browse(me.id, String(id), namespace));
    return result.error ? { error: result.error } : { ...result.value };
}

export async function rowsAction(
    id: string,
    namespace: string | null,
    relation: string,
    query: browser.RowRequest
): Promise<{ page?: DataPage; columns?: DataColumn[]; error?: string }> {
    const me = await actor();
    const result = await guard(() => browser.rows(me.id, String(id), namespace, relation, query));
    return result.error ? { error: result.error } : { page: result.value };
}

export async function runAction(
    id: string,
    statement: string
): Promise<{ results?: QueryResult[]; error?: string }> {
    const me = await actor();
    const result = await guard(() => browser.run(me.id, String(id), String(statement)));
    return result.error ? { error: result.error } : { results: result.value };
}

/**
 * Change one cell of one row.
 *
 * The only write this screen makes that is not a statement somebody typed, and
 * every guard it has is on the other side of this call: the connection's
 * read-only flag, the relation having to be one the connection holds, and the
 * edit having to name a whole primary key. Nothing is decided here beyond who is
 * asking.
 */
export async function updateCellAction(
    id: string,
    edit: {
        namespace: string | null;
        relation: string;
        column: string;
        value: string | null;
        key: Record<string, unknown>;
    }
): Promise<{ changed?: number; error?: string }> {
    const me = await actor();
    const result = await guard(() =>
        browser.updateCell(me.id, String(id), {
            namespace: edit.namespace,
            relation: String(edit.relation),
            column: String(edit.column),
            value: edit.value === null ? null : String(edit.value),
            key: edit.key
        })
    );
    return result.error ? { error: result.error } : { changed: result.value?.changed ?? 0 };
}

/** What one Redis key holds. Its own action because it is the one read that is
 *  about a single row rather than a page of them. */
export async function redisValueAction(
    id: string,
    namespace: string | null,
    key: string
): Promise<{ value?: browser.KeyValueView; error?: string }> {
    const me = await actor();
    const result = await guard(() => browser.keyValue(me.id, String(id), namespace, String(key)));
    return result.error ? { error: result.error } : { value: result.value };
}

/** One reading of what the database is doing. Polled by the stats panel, which
 *  keeps the readings and draws the window. */
export async function statsAction(id: string): Promise<{ stats?: DatabaseStats; error?: string }> {
    const me = await actor();
    const result = await guard(() => engineStats(me.id, String(id)));
    return result.error ? { error: result.error } : { stats: result.value };
}

/**
 * What is in the database and what it spends its time on.
 *
 * Asked once when the panel opens rather than on the poll: both answers change
 * over hours, and putting them on a five-second timer would mean a catalogue scan
 * every five seconds for a chart nobody is watching change.
 */
export async function insightsAction(
    id: string
): Promise<{ insights?: DatabaseInsights; error?: string }> {
    const me = await actor();
    const result = await guard(() => databaseInsights(me.id, String(id)));
    return result.error ? { error: result.error } : { insights: result.value };
}

/**
 * The servers this account has registered, for the tunnel picker.
 *
 * Name and address only: the form offers a server to tunnel through, and what
 * it signs in with stays on this side.
 */
export async function listTunnelServersAction(): Promise<{
    servers: { id: string; name: string; address: string }[];
}> {
    const me = await actor();
    const hosts = await listHosts(me.id);
    return {
        servers: hosts.map((host) => ({ id: host.id, name: host.name, address: host.address }))
    };
}

/** The engines a connection can be made for, for the form's picker. Server-side
 *  so the list cannot drift from what the drivers actually support. */
export async function engineOptionsAction(): Promise<{
    engines: { id: string; label: string; port: number }[];
}> {
    await actor();
    return {
        engines: core.DB_ENGINES.map((engine) => ({
            id: engine,
            label: core.DB_ENGINE_INFO[engine].label,
            port: core.DB_ENGINE_INFO[engine].port
        }))
    };
}
