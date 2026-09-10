/**
 * Variables that point at another service instead of copying its value.
 *
 * `DATABASE_URL=${{postgres.DATABASE_URL}}` says "the address of the database
 * called postgres in this environment", and is read when the service deploys.
 * A copied literal says "this one database, forever" - which is wrong the moment
 * the environment is cloned: a preview built from production would carry
 * production's password and talk to production's data. A reference is resolved
 * inside whichever environment the service is in, so the clone's service finds
 * the clone's database with nothing edited.
 *
 * The same syntax the platforms this is modelled on use, so a variable written
 * for one of them reads the same here:
 *
 * - `${{shared.KEY}}` - a variable set on the environment rather than a service.
 * - `${{service.KEY}}` - a variable of another service, by its name or slug.
 * - `${{database.URL}}` and friends - how to reach a managed database (below).
 * - `${{files.S3_ENDPOINT}}` and friends - how to reach a managed object store.
 *
 * This module is the pure half: finding references and substituting them. What a
 * name resolves to is the caller's to answer, because that needs the database.
 */

import { ENV_VALUE_MAX } from "./env-values.js";
import { objectStorageReferenceKeys, OBJECT_STORAGE_REGION } from "./schemas/object-storage.js";

/** One `${{ name.KEY }}`. Names are service slugs or `shared`; keys are what an
 *  environment variable may be called. */
const REFERENCE = /\$\{\{\s*([A-Za-z0-9][A-Za-z0-9_-]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** How many rounds of references-inside-references are followed, and so how many
 *  rounds of names a caller has to load. A value that still has one after this is
 *  a cycle, or a chain nobody should be maintaining. */
export const REFERENCE_DEPTH = 4;

export interface VariableReference {
    /** The service, the database, or `shared`. Lower-cased. */
    readonly name: string;
    readonly key: string;
    /** Exactly as written, for saying which one could not be resolved. */
    readonly written: string;
}

/** Every reference in a value, in order. */
export function referencesIn(value: string): VariableReference[] {
    return [...value.matchAll(REFERENCE)].map((match) => ({
        name: (match[1] ?? "").toLowerCase(),
        key: match[2] ?? "",
        written: match[0]
    }));
}

/** Whether a value says anything that has to be resolved. */
export function hasReferences(value: string): boolean {
    REFERENCE.lastIndex = 0;
    const found = REFERENCE.test(value);
    REFERENCE.lastIndex = 0;
    return found;
}

/** What a reference resolves to, or undefined when nothing by that name holds
 *  that key. */
export type ReferenceLookup = (name: string, key: string) => string | undefined;

/**
 * Substitute every reference in an environment.
 *
 * Answers the resolved variables and the references that could not be, as
 * written - the caller decides whether a deploy goes ahead with them, and the
 * answer here is that it should not: a service started with the literal text
 * `${{postgres.DATABASE_URL}}` in its connection string fails in a way that
 * names nothing Polaris could have told it.
 *
 * A reference to a value that itself holds references is followed, a few
 * levels deep. A cycle is left as it was and reported rather than looped on.
 *
 * Throws, naming the variable, when a value grows past `ENV_VALUE_MAX` - which
 * is checked as it grows, since a value repeating a reference to itself would
 * otherwise multiply in size with every round before anything looked.
 */
export function resolveReferences(
    env: Readonly<Record<string, string>>,
    lookup: ReferenceLookup
): { env: Record<string, string>; unresolved: string[] } {
    const out: Record<string, string> = {};
    const unresolved = new Set<string>();
    for (const [key, value] of Object.entries(env)) {
        let current = value;
        for (let depth = 0; depth < REFERENCE_DEPTH && hasReferences(current); depth += 1) {
            current = substitute(key, current, lookup);
        }
        for (const reference of referencesIn(current)) unresolved.add(reference.written);
        out[key] = current;
    }
    return { env: out, unresolved: [...unresolved] };
}

/** One round of substitution in one value, refused the moment it outgrows the limit. */
function substitute(key: string, value: string, lookup: ReferenceLookup): string {
    let out = "";
    let from = 0;
    for (const match of value.matchAll(REFERENCE)) {
        const found = lookup((match[1] ?? "").toLowerCase(), match[2] ?? "");
        out += value.slice(from, match.index) + (found ?? match[0]);
        from = match.index + match[0].length;
        if (out.length > ENV_VALUE_MAX) break;
    }
    out += value.slice(from);
    if (out.length > ENV_VALUE_MAX) {
        throw new Error(`${key} is longer than ${ENV_VALUE_MAX / 1024} KB once its references are filled in.`);
    }
    return out;
}

/**
 * The keys a managed database answers to, from what it takes to connect.
 *
 * The generic names first, then each engine's own conventional ones, so an
 * application that already reads `PGHOST` or `REDIS_URL` needs nothing renamed.
 */
export function databaseReferenceKeys(connection: {
    readonly engine: string;
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly username: string;
    readonly password: string;
    readonly uri: string;
    /** A Redis Cluster's nodes as `host:port`, the seeds a cluster client takes.
     *  Absent for anything that is not a cluster. */
    readonly clusterNodes?: readonly string[] | null;
}): Record<string, string> {
    const port = String(connection.port);
    const keys: Record<string, string> = {
        URL: connection.uri,
        DATABASE_URL: connection.uri,
        HOST: connection.host,
        PORT: port,
        USER: connection.username,
        USERNAME: connection.username,
        PASSWORD: connection.password,
        DATABASE: connection.database,
        NAME: connection.database
    };
    if (connection.engine === "postgres") {
        Object.assign(keys, {
            POSTGRES_URL: connection.uri,
            PGHOST: connection.host,
            PGPORT: port,
            PGUSER: connection.username,
            PGPASSWORD: connection.password,
            PGDATABASE: connection.database
        });
    } else if (connection.engine === "mysql" || connection.engine === "mariadb") {
        Object.assign(keys, {
            MYSQL_URL: connection.uri,
            MYSQLHOST: connection.host,
            MYSQLPORT: port,
            MYSQLUSER: connection.username,
            MYSQLPASSWORD: connection.password,
            MYSQLDATABASE: connection.database
        });
    } else if (connection.engine === "mongo") {
        keys.MONGO_URL = connection.uri;
    } else if (connection.engine === "redis") {
        Object.assign(keys, { REDIS_URL: connection.uri, REDISHOST: connection.host, REDISPORT: port });
        // A cluster's URL names one node; a cluster client wants every one.
        if (connection.clusterNodes?.length) keys.REDIS_CLUSTER_NODES = connection.clusterNodes.join(",");
    } else if (connection.engine === "seaweedfs") {
        // An object store's account is an S3 key pair; it answers with the names
        // S3 clients read, the AWS SDKs' own among them.
        Object.assign(
            keys,
            objectStorageReferenceKeys({
                endpoint: connection.uri,
                accessKeyId: connection.username,
                secretAccessKey: connection.password,
                region: OBJECT_STORAGE_REGION
            })
        );
    }
    return keys;
}
