/**
 * The Databases app's refusals, in the reader's words.
 *
 * The connection schema, the connection service, the tunnel and the drivers all
 * refuse in English - the same sentences are checked on the client and on the
 * server, and the drivers have no reader to ask - and the screens say them. This
 * matches each one back to its key in the `databases` catalog, exactly or by its
 * shape when it names a host, a server or a column. A sentence it does not know -
 * an engine's own error, a newer driver's - passes through as it was written.
 */

import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";

type Words = NamespaceTranslator<"databases">;
type Key = NamespaceKey<"databases">;

const EXACT: Readonly<Record<string, Key>> = {
    // The connection form's schema.
    "Give the address of the SSH server.": "refusals.sshHostMissing",
    "Give the address of the database.": "refusals.hostMissing",
    "That address is too long.": "refusals.addressTooLong",
    "Enter a hostname or an IP address, without the rest of a URL.": "refusals.notAHost",
    "That is not a port.": "refusals.notAPort",
    "That is too long.": "refusals.tooLong",
    "Pick the server to tunnel through.": "refusals.pickTunnel",
    "Enter the SSH user.": "refusals.sshUser",
    "That user is too long.": "refusals.userTooLong",
    "Pick the server to jump through.": "refusals.pickJump",
    "That connection is not there any more.": "refusals.connectionGone",
    "Give the connection a name.": "refusals.nameMissing",
    "That name is too long.": "refusals.nameTooLong",
    "Unknown engine.": "refusals.unknownEngine",
    "Pick a database.": "refusals.pickDatabase",
    "Paste the private key this passphrase is for, or clear the passphrase.": "refusals.passphraseAlone",
    // The connection service.
    "The server to tunnel through is not one of yours.": "refusals.tunnelNotYours",
    "The server to jump through is not one of yours.": "refusals.jumpNotYours",
    "Enter the password for the SSH login.": "refusals.sshPassword",
    "Paste the private key for the SSH login.": "refusals.sshKey",
    "That database is not one you can open.": "refusals.notYours",
    "The server this connection tunnels through is not one of yours any more.": "refusals.tunnelGone",
    "This connection's SSH login is incomplete. Edit it and save it again.": "refusals.sshIncomplete",
    "The server this tunnel jumps through is not one of yours any more.": "refusals.jumpGone",
    "That database is not there any more.": "refusals.databaseGone",
    "An object store is browsed from its Buckets panel, not as a database.": "refusals.objectStore",
    "This database runs on another server and is not published on a port, so Polaris cannot reach it from here. Publish it on a port from the database's own screen, then open it again.":
        "refusals.unpublished",
    "Runs on another server and is not published on a port, so Polaris cannot reach it from here.":
        "refusals.unpublishedShort",
    "A Redis cluster spreads its keys over several masters, and the browser reads one server at a time, so it cannot open one.":
        "refusals.redisCluster",
    // The drivers.
    "There is nothing here by that name.": "refusals.noSuchName",
    "Values in this kind of database are not edited from the grid.": "refusals.notEditable",
    "Only a Redis key has a value to open.": "refusals.redisOnly",
    "This table has no primary key, so there is no way to change one row of it without risking the others. Use the statement box.":
        "refusals.noPrimaryKey",
    "No such column to change.": "refusals.noSuchColumn",
    "That column is part of the primary key. Changing it moves the row, so it goes through the statement box.":
        "refusals.primaryKeyColumn",
    "That row cannot be identified - the page it came from did not carry its whole primary key.": "refusals.rowUnknown",
    "Open a database first.": "refusals.openFirst",
    'Type a command document, for example { find: "users", limit: 20 }.': "refusals.mongoEmpty",
    'That is not a command document. Mongo takes JSON here, for example { find: "users", filter: { active: true }, limit: 20 } - with the field names quoted.':
        "refusals.mongoNotJson",
    "That table has no columns to read.": "refusals.noColumns",
    "No such column to order by.": "refusals.noOrderColumn",
    "That key is not there any more.": "refusals.keyGone",
    "That did not work. Nothing was changed.": "refusals.generic",
    "Postgres only records this with the pg_stat_statements extension installed. Ask whoever runs this database to add it.":
        "insights.noPgStatStatements",
    "This server does not have the performance schema turned on, so it is not recording which statements run.":
        "insights.noPerformanceSchema",
    // What the list says about a connection.
    "Read-only. Polaris itself runs on this one.": "notes.polaris",
    "The server this connection tunnels through was removed from Servers. Edit it to pick another.": "notes.tunnelRemoved",
    "The server this tunnel jumps through was removed from Servers. Edit it to pick another.": "notes.jumpRemoved"
};

/** What a read-only connection refused, by what the driver said it was. */
const READ_ONLY_WHAT: Readonly<Record<string, Key>> = {
    "one of those statements": "refusals.readOnlyWhat.statements",
    "changing a value": "refusals.readOnlyWhat.value"
};

const SHAPED: readonly (readonly [RegExp, Key, readonly string[]])[] = [
    [
        /^Polaris could not sign in to (\S+) over SSH through (.+)\. Check the address, the user and the (password|key)\.$/,
        "refusals.sshSignInJump",
        ["target", "jump", "secret"]
    ],
    [
        /^Polaris could not sign in to (\S+) over SSH\. Check the address, the user and the (password|key)\.$/,
        "refusals.sshSignIn",
        ["target", "secret"]
    ],
    [
        /^Polaris cannot read the login stored for (.+)\. Add that server again under Servers, then save this connection\.$/,
        "refusals.loginUnreadable",
        ["server"]
    ],
    [
        /^Polaris has no key on record to check (.+) against, so it will not tunnel through it\. Remove it under Servers and add it again, then save this connection\.$/,
        "refusals.noHostKey",
        ["server"]
    ],
    [
        /^Polaris could not open the SSH tunnel through (.+)\. Check that the server is up and that the login still works\.$/,
        "refusals.tunnelFailed",
        ["server"]
    ],
    [
        /^(\S+) answered with a different key than the one Polaris pinned for this connection, so nothing was sent to it\. If that server was rebuilt, remove this connection and add it again\.$/,
        "refusals.keyChanged",
        ["target"]
    ],
    [/^(.+) cannot be empty\.$/, "refusals.cannotBeEmpty", ["column"]]
];

const READ_ONLY =
    /^This connection is read-only, and (.+) would change the database\. Turn read-only off on the connection if you meant to\.$/;

/** Every exact English sentence this knows, for the test that holds the catalog to it. */
export const KNOWN_DATA_REFUSALS: readonly string[] = Object.keys(EXACT);

export function dataText(t: Words, message: string): string;
export function dataText(t: Words, message: string | undefined): string | undefined;
export function dataText(t: Words, message: string | undefined): string | undefined {
    if (message === undefined) return undefined;
    const exact = EXACT[message];
    if (exact) return t(exact);
    const readOnly = READ_ONLY.exec(message);
    if (readOnly) {
        const said = readOnly[1] ?? "";
        const what = READ_ONLY_WHAT[said];
        return t("refusals.readOnly", { what: what ? t(what) : said });
    }
    for (const [pattern, key, names] of SHAPED) {
        const match = pattern.exec(message);
        if (!match) continue;
        const params: Record<string, string> = {};
        names.forEach((name, index) => {
            const value = match[index + 1] ?? "";
            params[name] = name === "secret" ? t(value === "password" ? "refusals.secretPassword" : "refusals.secretKey") : value;
        });
        return t(key, params);
    }
    return message;
}

/** Where a connection points, as the list says it: a host and port, the tunnel it
 *  goes through, or Polaris' own. Names and addresses are kept as they are. */
export function whereText(t: Words, where: string): string {
    if (where === "The instance's own data") return t("where.polaris");
    const via = /^(\S*) via (.+)$/.exec(where);
    if (!via) return where;
    const route = via[2] ?? "";
    const through = /^(\S+) through (.+)$/.exec(route);
    const tunnel =
        route === "a removed server"
            ? t("where.removedServer")
            : through
              ? t("where.through", { login: through[1] ?? "", jump: through[2] ?? "" })
              : route;
    return t("where.via", { direct: via[1] ?? "", tunnel });
}

/** What each engine's figures are called, by the English `lib/data/stats` gives
 *  them - the same key means different things on different engines, so it is the
 *  label that is matched. A figure a newer driver adds keeps its own name. */
const STAT_LABELS: Readonly<Record<string, Key>> = {
    "Commands a second": "stats.labels.commandsPerSecond",
    "Connections": "stats.labels.connections",
    "Memory": "stats.labels.memory",
    "Keys": "stats.labels.keys",
    "Memory fragmentation": "stats.labels.fragmentation",
    "Commands": "stats.labels.commands",
    "Cache hits": "stats.labels.cacheHits",
    "Cache misses": "stats.labels.cacheMisses",
    "Expired keys": "stats.labels.expiredKeys",
    "Evicted keys": "stats.labels.evictedKeys",
    "Connections opened": "stats.labels.connectionsOpened",
    "Bytes in": "stats.labels.bytesIn",
    "Bytes out": "stats.labels.bytesOut",
    "Running queries": "stats.labels.runningQueries",
    "Size on disk": "stats.labels.sizeOnDisk",
    "Transactions": "stats.labels.transactions",
    "Rollbacks": "stats.labels.rollbacks",
    "Blocks read from disk": "stats.labels.blocksFromDisk",
    "Rows read": "stats.labels.rowsRead",
    "Rows inserted": "stats.labels.rowsInserted",
    "Rows updated": "stats.labels.rowsUpdated",
    "Rows deleted": "stats.labels.rowsDeleted",
    "Deadlocks": "stats.labels.deadlocks",
    "Spilled to disk": "stats.labels.spilled",
    "Statements": "stats.labels.statements",
    "Selects": "stats.labels.selects",
    "Writes": "stats.labels.writes",
    "Buffer pool hits": "stats.labels.bufferHits",
    "Read from disk": "stats.labels.readFromDisk",
    "Slow queries": "stats.labels.slowQueries",
    "Refused connections": "stats.labels.refusedConnections",
    "Connections free": "stats.labels.connectionsFree",
    "Collections": "stats.labels.collections",
    "Documents": "stats.labels.documents",
    "Queries": "stats.labels.queries",
    "Inserts": "stats.labels.inserts",
    "Updates": "stats.labels.updates",
    "Deletes": "stats.labels.deletes",
    "Cursor reads": "stats.labels.cursorReads"
};

export function statText(t: Words, label: string): string {
    const key = STAT_LABELS[label];
    return key ? t(key) : label;
}
