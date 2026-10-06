/**
 * A connection URL somebody pasted, read into the connection form's fields.
 *
 * What every client takes and every host hands out: `postgres://`,
 * `postgresql://`, `mysql://`, `mariadb://`, `mongodb://`, `redis://` and
 * `rediss://`, with the login, the host, the port, the database and the
 * encryption the provider asked for in the query (libpq's `sslmode`, MySQL's
 * `ssl-mode`, MongoDB's `tls`). Only fills the form: nothing is saved from
 * here, and the form checks what it was given exactly as if it were typed.
 *
 * Encryption follows the URL, read the strict way where it is loose: libpq's
 * `prefer` and `allow` fall back to plain when the server refuses, which this
 * form has no mode for, so they arrive as "on, not verified" and say so. A
 * bare `ssl=true` arrives as full verification, which is what drivers that
 * take it do by default.
 *
 * Client-safe.
 */

import type { DbEngine } from "@polaris/core";
import type { TlsMode } from "./connection-schema";

export interface ImportedConnection {
    readonly engine: DbEngine;
    readonly host: string;
    /** Null when the URL named none: the engine's own port. */
    readonly port: number | null;
    readonly database: string;
    readonly username: string;
    readonly password: string;
    /** Null when the URL said nothing about encryption. */
    readonly tlsMode: TlsMode | null;
    /** Whether `prefer` or `allow` was read as "on, not verified". */
    readonly softened: boolean;
}

/** Why a URL could not be read: not a URL of a scheme this form knows, a
 *  MongoDB SRV record, which names no host to connect to, or a list of hosts
 *  (a replica set, libpq's failover list) where the form takes one. */
export type ConnectionUrlRefusal = "unreadable" | "scheme" | "srv" | "multihost";

const SCHEMES: Readonly<Record<string, DbEngine>> = {
    postgres: "postgres",
    postgresql: "postgres",
    mysql: "mysql",
    mariadb: "mariadb",
    mongodb: "mongo",
    redis: "redis",
    rediss: "redis"
};

const LIBPQ_MODES: Readonly<Record<string, TlsMode>> = {
    disable: "disable",
    allow: "require",
    prefer: "require",
    require: "require",
    "verify-ca": "verify-ca",
    "verify-full": "verify-full"
};

const MYSQL_MODES: Readonly<Record<string, TlsMode>> = {
    disabled: "disable",
    preferred: "require",
    required: "require",
    verify_ca: "verify-ca",
    verify_identity: "verify-full"
};

const AUTHORITY = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i;

/** Whether a URL of a known scheme lists more than one host, which the WHATWG
 *  parser either rejects as a bad port or reads as one host named `h1,h2`. */
function listsHosts(raw: string): boolean {
    const match = AUTHORITY.exec(raw);
    if (!match || !SCHEMES[match[1]!.toLowerCase()]) return false;
    const authority = match[2]!;
    return authority.slice(authority.lastIndexOf("@") + 1).includes(",");
}

function decoded(value: string): string | null {
    try {
        return decodeURIComponent(value);
    } catch {
        return null;
    }
}

function encryption(
    scheme: string,
    query: URLSearchParams
): { mode: TlsMode | null; softened: boolean } {
    if (scheme === "rediss") return { mode: "verify-full", softened: false };
    const libpq = query.get("sslmode")?.toLowerCase();
    if (libpq && LIBPQ_MODES[libpq]) {
        return { mode: LIBPQ_MODES[libpq], softened: libpq === "allow" || libpq === "prefer" };
    }
    const mysql = (query.get("ssl-mode") ?? query.get("sslMode"))?.toLowerCase();
    if (mysql && MYSQL_MODES[mysql]) {
        return { mode: MYSQL_MODES[mysql], softened: mysql === "preferred" };
    }
    const flag = (query.get("tls") ?? query.get("ssl"))?.toLowerCase();
    if (flag === "false") return { mode: "disable", softened: false };
    if (flag === "true") {
        const lax =
            query.get("tlsAllowInvalidCertificates") === "true" ||
            query.get("tlsInsecure") === "true";
        return { mode: lax ? "require" : "verify-full", softened: false };
    }
    return { mode: null, softened: false };
}

/** The form's fields from a connection URL, or why it could not be read. */
export function parseConnectionUrl(
    raw: string
): { ok: true; connection: ImportedConnection } | { ok: false; refusal: ConnectionUrlRefusal } {
    const trimmed = raw.trim();
    if (listsHosts(trimmed)) return { ok: false, refusal: "multihost" };
    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        return { ok: false, refusal: "unreadable" };
    }
    const scheme = url.protocol.replace(/:$/, "").toLowerCase();
    if (scheme === "mongodb+srv") return { ok: false, refusal: "srv" };
    const engine = SCHEMES[scheme];
    if (!engine) return { ok: false, refusal: "scheme" };
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!host) return { ok: false, refusal: "unreadable" };
    const path = decoded(url.pathname.replace(/^\//, ""));
    const username = decoded(url.username);
    const password = decoded(url.password);
    if (path === null || username === null || password === null)
        return { ok: false, refusal: "unreadable" };
    const { mode, softened } = encryption(scheme, url.searchParams);
    return {
        ok: true,
        connection: {
            engine,
            host,
            port: url.port ? Number(url.port) : null,
            // A path past the database (`/app/extra`) is not part of one.
            database: path.split("/")[0] ?? "",
            username,
            password,
            tlsMode: mode,
            softened
        }
    };
}
