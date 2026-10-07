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
import { DRIVER_REFUSALS } from "./driver-refusal";

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
    "Paste the private key this passphrase is for, or clear the passphrase.":
        "refusals.passphraseAlone",
    "That file is too large.": "refusals.fileTooLarge",
    "That is a public key. Use the private key - the file without .pub.": "refusals.publicKey",
    "That is not a private key Polaris can read. Use an OpenSSH, PEM or PuTTY key.":
        "refusals.notAKey",
    "This key is locked with a passphrase. Enter it below.": "refusals.keyLocked",
    "That file holds a private key. Use the certificate here.": "refusals.certIsKey",
    "That is not a PEM certificate.": "refusals.notACert",
    "That is not a PEM private key.": "refusals.notAPemKey",
    "This key is locked with a passphrase. Save a copy without one and use that file.":
        "refusals.pemKeyLocked",
    "Add the key that goes with this certificate.": "refusals.clientKeyMissing",
    "Add the certificate that goes with this key.": "refusals.clientCertMissing",
    // Reading a private key.
    "That passphrase does not unlock this key.": "refusals.wrongPassphrase",
    "Polaris cannot use this kind of key. Use an Ed25519, ECDSA or RSA key.":
        "refusals.keyUnsupported",
    "This key asks for more work to unlock than Polaris allows. Save it again with fewer KDF rounds (100 or less).":
        "refusals.keyTooCostly",
    "This PuTTY key is locked in PuTTY's newer format, which Polaris cannot unlock. In PuTTYgen, export it as an OpenSSH key, or save it with no passphrase, and use that file.":
        "refusals.puttyV3",
    // TLS.
    "The database's certificate is not signed by an authority this connection trusts, so nothing was sent to it. If its certificate was replaced, check it in the connection's settings.":
        "refusals.certUntrusted",
    "The database's certificate has expired or is not valid yet, so nothing was sent to it.":
        "refusals.certExpired",
    "This database server does not accept encrypted connections. Turn encryption off for it, or turn TLS on at the server.":
        "refusals.noTls",
    "The server's certificate is signed by an authority it does not send, so there is nothing to trust on first use. Upload that authority's certificate instead.":
        "refusals.noRoot",
    // Saving and checking.
    "Enter the password again. The encryption is weaker now, and a saved password is only sent over a connection as safe as the one it was saved for.":
        "refusals.passwordAgainTls",
    "Enter the password again. The address changed, and a saved password is only sent to the address it was saved for.":
        "refusals.passwordAgain",
    "Enter the SSH password or key again. The SSH server changed, and a saved login is only sent to the server it was saved for.":
        "refusals.sshSecretAgain",
    "Upload the certificate of the authority that signed the server's certificate.":
        "refusals.caMissing",
    "That certificate file could not be read. Use a PEM file with one or more certificates.":
        "refusals.caInvalid",
    "Add the client certificate and its key.": "refusals.clientMissing",
    "That client certificate and key could not be read, or do not belong together.":
        "refusals.clientInvalid",
    "The server's key changed again since you checked it. Check it again before trusting it.":
        "refusals.keyChangedAgain",
    "The server's certificate changed again since you checked it. Check it again before trusting it.":
        "refusals.certChangedAgain",
    "This connection does not trust the server's own certificate, so there is nothing to check.":
        "refusals.notTofu",
    "This connection has no SSH login of its own to check.": "refusals.notManualTunnel",
    "The saved password could not be read. Enter it again.": "refusals.secretUnreadable",
    // The connection service.
    "The server to tunnel through is not one of yours.": "refusals.tunnelNotYours",
    "The server to jump through is not one of yours.": "refusals.jumpNotYours",
    "Enter the password for the SSH login.": "refusals.sshPassword",
    "Paste the private key for the SSH login.": "refusals.sshKey",
    "That database is not one you can open.": "refusals.notYours",
    "The server this connection tunnels through is not one of yours any more.":
        "refusals.tunnelGone",
    "This connection's SSH login is incomplete. Edit it and save it again.":
        "refusals.sshIncomplete",
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
    "There is no database by that name on this server.": "refusals.noSuchDatabase",
    "Values in this kind of database are not edited from the grid.": "refusals.notEditable",
    "Only a Redis key has a value to open.": "refusals.redisOnly",
    "This table has no primary key, so there is no way to change one row of it without risking the others. Use the statement box.":
        "refusals.noPrimaryKey",
    "No such column to change.": "refusals.noSuchColumn",
    "That column is part of the primary key. Changing it moves the row, so it goes through the statement box.":
        "refusals.primaryKeyColumn",
    "That row cannot be identified - the page it came from did not carry its whole primary key.":
        "refusals.rowUnknown",
    "Open a database first.": "refusals.openFirst",
    'Type a command document, for example { find: "users", limit: 20 }.': "refusals.mongoEmpty",
    'That is not a command document. Mongo takes JSON here, for example { find: "users", filter: { active: true }, limit: 20 } - with the field names quoted.':
        "refusals.mongoNotJson",
    "That table has no columns to read.": "refusals.noColumns",
    "No such column to order by.": "refusals.noOrderColumn",
    "That key is not there any more.": "refusals.keyGone",
    // A database turning a connection away (driver-refusal.ts).
    [DRIVER_REFUSALS.credentials]: "refusals.driverCredentials",
    [DRIVER_REFUSALS.notAllowed]: "refusals.driverNotAllowed",
    [DRIVER_REFUSALS.noDatabase]: "refusals.driverNoDatabase",
    [DRIVER_REFUSALS.noAccess]: "refusals.driverNoAccess",
    [DRIVER_REFUSALS.tooMany]: "refusals.driverTooMany",
    [DRIVER_REFUSALS.starting]: "refusals.driverStarting",
    [DRIVER_REFUSALS.refused]: "refusals.driverRefused",
    [DRIVER_REFUSALS.timeout]: "refusals.driverTimeout",
    [DRIVER_REFUSALS.unknownHost]: "refusals.driverUnknownHost",
    [DRIVER_REFUSALS.closed]: "refusals.driverClosed",
    [DRIVER_REFUSALS.noTls]: "refusals.driverNoTls",
    "That did not work. Nothing was changed.": "refusals.generic",
    "Postgres only records this with the pg_stat_statements extension installed. Ask whoever runs this database to add it.":
        "insights.noPgStatStatements",
    "This server does not have the performance schema turned on, so it is not recording which statements run.":
        "insights.noPerformanceSchema",
    // New tables, new rows and removals (row-edit.ts, row-edit-schema.ts).
    "A table name starts with a letter or an underscore and holds only letters, digits and underscores.":
        "refusals.tableName",
    "A column name starts with a letter or an underscore and holds only letters, digits and underscores.":
        "refusals.columnNameRule",
    "That default is not one Polaris offers.": "refusals.unknownDefault",
    "A default can be at most 200 characters.": "refusals.defaultTooLong",
    "A default cannot hold a backslash or a line break.": "refusals.defaultBackslash",
    "That default has to be a number.": "refusals.defaultNumber",
    "A yes/no column takes true or false as its default.": "refusals.defaultBoolean",
    "This table has no primary key, so there is no way to remove one row of it without risking the others. Use the statement box.":
        "refusals.noPrimaryKeyDelete",
    "Pick the rows to remove.": "refusals.pickRows",
    "Remove at most 200 rows at a time from here.": "refusals.tooManyRows",
    "A table made here can have at most 100 columns.": "refusals.tooManyColumns",
    "Give the table at least one column.": "refusals.noColumnsGiven",
    "Rows in this kind of database are not added or removed from the grid.": "refusals.noRowWrites",
    "Tables in this kind of database are not created from here.": "refusals.noCreateTable",
    // A Deploy database's Stats and Config (maintenance.ts, database-ops/admin.ts).
    "Database not found": "refusals.databaseNotFound",
    "This server does not ship that extension.": "refusals.notShipped",
    "That extension is not installed here.": "refusals.notInstalled",
    "That extension is part of the database and stays.": "refusals.keptExtension",
    "Query statistics are recorded by PostgreSQL only.": "refusals.statsPostgresOnly",
    "This database lives inside another instance; turn statistics on for that instance.":
        "refusals.statsHosted",
    "Deploy this database first - it has no container yet.": "refusals.deployFirst",
    "An object store's keys are managed from its Buckets panel.": "refusals.objectStoreKeys",
    "This instance runs as several containers, and their passwords are changed together by redeploying it, not from here.":
        "refusals.severalContainers",
    "This database lives inside another instance; publish that instance instead.":
        "refusals.publishHosted",
    "Pick a port between 1024 and 65535.": "refusals.portRange",
    "Ports 20000 to 39999 are kept for services. Pick another.": "refusals.portServices",
    "Another database on this server already uses that port.": "refusals.portTaken",
    "Vacuum is a PostgreSQL command.": "refusals.vacuumPostgres",
    "Extensions are a PostgreSQL feature.": "refusals.extensionsPostgres",
    // What the list says about a connection.
    "Read-only. Polaris itself runs on this one.": "notes.polaris",
    "The server this connection tunnels through was removed from Servers. Edit it to pick another.":
        "notes.tunnelRemoved",
    "The server this tunnel jumps through was removed from Servers. Edit it to pick another.":
        "notes.jumpRemoved"
};

/** What a read-only connection refused, by what the driver said it was. */
const READ_ONLY_WHAT: Readonly<Record<string, Key>> = {
    "one of those statements": "refusals.readOnlyWhat.statements",
    "changing a value": "refusals.readOnlyWhat.value",
    "adding a row": "refusals.readOnlyWhat.row",
    "removing rows": "refusals.readOnlyWhat.rows",
    "creating a table": "refusals.readOnlyWhat.table"
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
        /^(.+) does not allow port forwarding for this SSH login, so the database cannot be reached through it\. Allow TCP forwarding for that user in the server's SSH settings\.$/,
        "refusals.forwardProhibited",
        ["server"]
    ],
    [
        /^(.+) could not reach the database at (\S+)\. Check that the database is running and listening on that address\.$/,
        "refusals.forwardUnreachable",
        ["server", "address"]
    ],
    [
        /^(.+) answered with a different SSH key than the one pinned for this connection, so nothing was sent to it\. If that server was rebuilt, check the new key in the connection's settings and trust it there\.$/,
        "refusals.keyChanged",
        ["target"]
    ],
    [
        /^(.+) answered with a different SSH key than the one Polaris has on record for it, so nothing was sent to it\. Check that server under Servers\.$/,
        "refusals.jumpKeyChanged",
        ["server"]
    ],
    [
        /^Polaris could not reach (\S+) to read its key\. Check that the server is up\.$/,
        "refusals.keyUnreachable",
        ["target"]
    ],
    [
        /^Polaris could not reach (\S+) to read its certificate\.$/,
        "refusals.certUnreachable",
        ["target"]
    ],
    [
        /^The database's certificate is not for (.+), so nothing was sent to it\.$/,
        "refusals.certWrongName",
        ["host"]
    ],
    [
        /^Polaris does not connect to (\S+): it is a link-local or metadata address, which never holds a database\.$/,
        "refusals.egressForbidden",
        ["host"]
    ],
    [
        /^(\S+) is on a private network, which only an administrator can reach from Polaris\. Reach it over SSH through a server of yours instead\.$/,
        "refusals.egressInternal",
        ["host"]
    ],
    [/^Polaris could not find (\S+)\. Check the name\.$/, "refusals.egressUnresolved", ["host"]],
    [/^Showing the first (\d+) rows\.$/, "bench.truncated", ["count"]],
    [/^(.+) cannot be empty\.$/, "refusals.cannotBeEmpty", ["column"]],
    [
        /^"(.+)" cannot be a column name: letters, digits and underscores, starting with a letter\.$/,
        "refusals.columnName",
        ["column"]
    ],
    [/^There are two columns called (.+)\.$/, "refusals.duplicateColumn", ["column"]],
    [/^Pick a type for (.+)\.$/, "refusals.pickType", ["column"]],
    [
        /^(.+) is numbered automatically, so it has to be the primary key\.$/,
        "refusals.autoKey",
        ["column"]
    ],
    [/^(.+) is numbered automatically and takes no default\.$/, "refusals.autoDefault", ["column"]],
    [/^That default does not fit the type of (.+)\.$/, "refusals.defaultType", ["column"]],
    [/^There is no column called (.+)\.$/, "refusals.unknownColumn", ["column"]],
    [
        /^The instance did not start that way, so it was put back: (.+)$/,
        "refusals.putBack",
        ["reason"]
    ],
    [
        /^The database did not start that way, so it was put back: (.+)$/,
        "refusals.publicPutBack",
        ["reason"]
    ],
    [
        /^Changing the password of (.+?) failed: (.+)$/,
        "refusals.passwordChangeSaid",
        ["user", "reason"]
    ],
    [/^Changing the password of (.+) failed$/, "refusals.passwordChange", ["user"]]
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
            params[name] =
                name === "secret"
                    ? t(value === "password" ? "refusals.secretPassword" : "refusals.secretKey")
                    : value;
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
    Connections: "stats.labels.connections",
    Memory: "stats.labels.memory",
    Keys: "stats.labels.keys",
    "Memory fragmentation": "stats.labels.fragmentation",
    Commands: "stats.labels.commands",
    "Cache hits": "stats.labels.cacheHits",
    "Cache misses": "stats.labels.cacheMisses",
    "Expired keys": "stats.labels.expiredKeys",
    "Evicted keys": "stats.labels.evictedKeys",
    "Connections opened": "stats.labels.connectionsOpened",
    "Bytes in": "stats.labels.bytesIn",
    "Bytes out": "stats.labels.bytesOut",
    "Running queries": "stats.labels.runningQueries",
    "Size on disk": "stats.labels.sizeOnDisk",
    Transactions: "stats.labels.transactions",
    Rollbacks: "stats.labels.rollbacks",
    "Blocks read from disk": "stats.labels.blocksFromDisk",
    "Rows read": "stats.labels.rowsRead",
    "Rows inserted": "stats.labels.rowsInserted",
    "Rows updated": "stats.labels.rowsUpdated",
    "Rows deleted": "stats.labels.rowsDeleted",
    Deadlocks: "stats.labels.deadlocks",
    "Spilled to disk": "stats.labels.spilled",
    Statements: "stats.labels.statements",
    Selects: "stats.labels.selects",
    Writes: "stats.labels.writes",
    "Buffer pool hits": "stats.labels.bufferHits",
    "Read from disk": "stats.labels.readFromDisk",
    "Slow queries": "stats.labels.slowQueries",
    "Refused connections": "stats.labels.refusedConnections",
    "Connections free": "stats.labels.connectionsFree",
    Collections: "stats.labels.collections",
    Documents: "stats.labels.documents",
    Queries: "stats.labels.queries",
    Inserts: "stats.labels.inserts",
    Updates: "stats.labels.updates",
    Deletes: "stats.labels.deletes",
    "Cursor reads": "stats.labels.cursorReads"
};

export function statText(t: Words, label: string): string {
    const key = STAT_LABELS[label];
    return key ? t(key) : label;
}
