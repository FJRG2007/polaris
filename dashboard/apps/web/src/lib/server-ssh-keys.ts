/**
 * The keys that can sign in to a server, managed from Polaris.
 *
 * Everything here runs over the SSH connection Polaris already holds for the
 * server: no daemon on the machine and nothing resident. Reading a login's file
 * is one command and changing it is one more, so a key is listed, added or taken
 * away on demand and nothing about it is kept on Polaris's side.
 *
 * The login Polaris signs in as can manage its own file. Every other login's file
 * is only reachable as root, which means the server was enrolled with root
 * (password-less sudo); without it the panel offers Polaris's own login and says
 * why the others are not there.
 *
 * Writes are compare-and-swap. The file is read, changed here, and written back
 * only if it still has the checksum it had when it was read - somebody editing it
 * on the machine in between makes the write refuse rather than lose their line.
 * The new file is written beside the old one and renamed over it, so an
 * interrupted write never leaves a login locked out by an empty file.
 *
 * Key material: public keys are not secret but are still never logged; a private
 * key minted here is returned to the caller once and kept nowhere.
 *
 * Server-only.
 */

import { z } from "zod";
import { createHash } from "node:crypto";
import { borrowSsh } from "@/lib/connection-pool";
import { normalizeSshPublicKey } from "@polaris/core";
import { githubCredentialsForUser } from "@/lib/github-access";
import { getHostConnection, type HostConnection } from "@/lib/host-service";
import { execCommand, generateSshKeyPair, parseKey, publicKeyBlob } from "@polaris/ssh";

/** A reason a key operation could not go ahead, said by the action in the
 *  reader's language. */
export type ServerKeysProblem =
    | "unreachable"
    | "needsRoot"
    | "noSuchLogin"
    | "changedMeanwhile"
    | "protectedKey"
    | "notFound"
    | "failed";

export class ServerKeysError extends Error {
    constructor(readonly problem: ServerKeysProblem) {
        super(problem);
    }
}

export interface AuthorizedKey {
    type: string;
    comment: string;
    fingerprint: string;
    /** Options in front of the key (`from=`, `command=`...), which limit it. */
    options: string;
    /** The key Polaris itself signs in with. Removing it would cut Polaris off. */
    polaris: boolean;
}

export interface ServerLogin {
    name: string;
    /** Polaris's own login on this server. */
    self: boolean;
}

/** OpenSSH's fingerprint of a key blob: `SHA256:` and the unpadded base64 hash. */
export function keyFingerprint(blob: string): string {
    const digest = createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64");
    return `SHA256:${digest.replace(/=+$/, "")}`;
}

/** One `authorized_keys` line taken apart, or null for a blank, a comment, or
 *  anything that is not a key. Options may precede the type and may contain
 *  quoted spaces, so the key is found by its type rather than by position. */
export function parseAuthorizedKeyLine(raw: string): (AuthorizedKey & { blob: string }) | null {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return null;
    const match = /(?:^|\s)((?:ssh-|ecdsa-|sk-)\S+)\s+([A-Za-z0-9+/]+={0,2})(?:\s+(.*))?$/.exec(line);
    if (!match) return null;
    const [, type, blob, comment = ""] = match;
    if (!type || !blob || !publicKeyBlob(`${type} ${blob}`)) return null;
    const options = line.slice(0, match.index).trim();
    return { type, blob, comment: comment.trim(), fingerprint: keyFingerprint(blob), options, polaris: false };
}

export function parseAuthorizedKeys(text: string, polarisBlob: string | null): AuthorizedKey[] {
    const keys: AuthorizedKey[] = [];
    for (const raw of text.split("\n")) {
        const parsed = parseAuthorizedKeyLine(raw);
        if (!parsed) continue;
        const { blob, ...key } = parsed;
        keys.push({ ...key, polaris: blob === polarisBlob });
    }
    return keys;
}

/** The file with every line of one key taken out, everything else untouched. */
export function withoutKey(text: string, fingerprint: string): string {
    const kept = text
        .split("\n")
        .filter((raw) => parseAuthorizedKeyLine(raw)?.fingerprint !== fingerprint);
    return kept.join("\n");
}

/** The file with `lines` appended, skipping any key already in it. */
export function withKeys(text: string, lines: string[]): { text: string; added: number } {
    const present = new Set(parseAuthorizedKeys(text, null).map((key) => key.fingerprint));
    const fresh: string[] = [];
    for (const line of lines) {
        const parsed = parseAuthorizedKeyLine(normalizeSshPublicKey(line));
        if (!parsed || present.has(parsed.fingerprint)) continue;
        present.add(parsed.fingerprint);
        fresh.push(normalizeSshPublicKey(line));
    }
    if (fresh.length === 0) return { text, added: 0 };
    const base = text === "" || text.endsWith("\n") ? text : `${text}\n`;
    return { text: `${base}${fresh.join("\n")}\n`, added: fresh.length };
}

export function checksum(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Logins worth offering, out of `name:uid:home:shell` lines: root and real
 * accounts, never the system ones that cannot sign in anyway.
 */
export function loginsFrom(listing: string, self: string, minUid: number): ServerLogin[] {
    const names = new Set<string>();
    for (const raw of listing.split("\n")) {
        const [name, uidText, , shell = ""] = raw.trim().split(":");
        const uid = Number(uidText);
        if (!name || !/^[a-z_][a-z0-9_-]{0,31}$/.test(name) || !Number.isInteger(uid)) continue;
        if (/(nologin|false)$/.test(shell)) continue;
        if (uid === 0 || uid >= minUid) names.add(name);
    }
    names.add(self);
    return [...names]
        .sort((a, b) => (a === self ? -1 : b === self ? 1 : a.localeCompare(b)))
        .map((name) => ({ name, self: name === self }));
}

// The scripts below run through `sh -c '<script>' sh <login> [checksum]`, so
// they must not contain a single quote; a test holds them to that. The login is
// already held to the POSIX name set by the schema.

/** Every account: Linux through getent, macOS through the directory service. */
export const LIST_LOGINS = [
    "if command -v getent >/dev/null 2>&1; then getent passwd | cut -d: -f1,3,6,7;",
    "elif command -v dscl >/dev/null 2>&1; then dscl . -list /Users UniqueID | while read n u; do echo \"$n:$u:/Users/$n:/bin/sh\"; done; fi"
].join(" ");

/** Resolve the login's home, or exit 3 when there is no such login. */
const HOME_OF = [
    'u="$1"',
    'h=$(getent passwd "$u" 2>/dev/null | cut -d: -f6)',
    '[ -n "$h" ] || h=$(dscl . -read "/Users/$u" NFSHomeDirectory 2>/dev/null | sed "s/^NFSHomeDirectory: //")',
    '[ -n "$h" ] || exit 3'
].join("\n");

export const READ_KEYS = [HOME_OF, 'f="$h/.ssh/authorized_keys"', '[ -f "$f" ] || exit 0', 'cat "$f"'].join("\n");

/** Replace the file with stdin, only if it still has checksum `$2`. */
export const WRITE_KEYS = [
    HOME_OF,
    "umask 077",
    'd="$h/.ssh"; f="$d/authorized_keys"',
    "sum() { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi | cut -c1-64; }",
    'now=$(cat "$f" 2>/dev/null | sum)',
    '[ "$now" = "$2" ] || exit 4',
    'mkdir -p "$d" && chmod 700 "$d"',
    't="$d/.authorized_keys.polaris.$$"',
    'cat > "$t" || { rm -f "$t"; exit 5; }',
    'chmod 600 "$t"',
    'chown "$u" "$d" "$t" 2>/dev/null || true',
    'mv -f "$t" "$f"'
].join("\n");

/** How a script is started for a login: as that login itself when it is
 *  Polaris's own, through sudo for anyone else. */
export function scriptCommand(script: string, login: string, self: string, extra: string[] = []): string {
    if (script.includes("'")) throw new Error("A key script must not contain a single quote");
    const sudo = login === self ? "" : "sudo -n ";
    return `${sudo}sh -c '${script}' sh ${[login, ...extra].join(" ")}`;
}

interface Ran {
    code: number;
    out: string;
    err: string;
}

/** Bound on what one command's output is read to. An authorized_keys file is a
 *  few kilobytes; anything past this is not one. */
const MAX_OUTPUT = 512 * 1024;

async function run(connection: HostConnection, command: string, input?: string): Promise<Ran> {
    let lease;
    try {
        lease = await borrowSsh("exec", connection.id, {
            host: connection.address,
            port: connection.port,
            username: connection.username,
            auth: connection.auth,
            pinnedHostKey: connection.hostKey
        });
    } catch {
        throw new ServerKeysError("unreachable");
    }
    try {
        // Collected as bytes and decoded once, so a multi-byte character split
        // across two chunks survives and the checksum matches the file.
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        let outSize = 0;
        let errSize = 0;
        const result = await execCommand(lease.client, command, {
            input,
            onStdout: (chunk) => {
                if (outSize >= MAX_OUTPUT) return;
                out.push(chunk);
                outSize += chunk.length;
            },
            onStderr: (chunk) => {
                if (errSize >= 4096) return;
                err.push(chunk);
                errSize += chunk.length;
            }
        });
        return {
            code: result.code,
            out: Buffer.concat(out).toString("utf8"),
            err: Buffer.concat(err).toString("utf8")
        };
    } catch {
        throw new ServerKeysError("unreachable");
    } finally {
        lease.release();
    }
}

/** Turn a script's exit into the problem it means. */
function problemOf(ran: Ran): ServerKeysProblem {
    if (ran.code === 3) return "noSuchLogin";
    if (ran.code === 4) return "changedMeanwhile";
    if (/sudo:/.test(ran.err)) return "needsRoot";
    return "failed";
}

/** The public half of the key Polaris signs in with, to mark it in the list. */
function polarisBlob(connection: HostConnection): string | null {
    if (connection.auth.method !== "key" || !connection.auth.privateKey) return null;
    const parsed = parseKey(connection.auth.privateKey);
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!key || key instanceof Error) return null;
    return key.getPublicSSH().toString("base64");
}

async function connectionFor(hostId: string, ownerId: string, login: string): Promise<HostConnection> {
    const connection = await getHostConnection(hostId, ownerId);
    if (login !== connection.username && !connection.sudo) throw new ServerKeysError("needsRoot");
    return connection;
}

async function readFile(connection: HostConnection, login: string): Promise<string> {
    const ran = await run(connection, scriptCommand(READ_KEYS, login, connection.username));
    if (ran.code !== 0) throw new ServerKeysError(problemOf(ran));
    return ran.out;
}

async function writeFile(connection: HostConnection, login: string, before: string, after: string): Promise<void> {
    const ran = await run(
        connection,
        scriptCommand(WRITE_KEYS, login, connection.username, [checksum(before)]),
        after
    );
    if (ran.code !== 0) throw new ServerKeysError(problemOf(ran));
}

export interface ServerKeysView {
    logins: ServerLogin[];
    /** Whether Polaris can reach logins other than its own. */
    root: boolean;
    login: string;
    keys: AuthorizedKey[];
}

/** The logins on a server and the keys of one of them (Polaris's own by default). */
export async function listServerKeys(
    hostId: string,
    ownerId: string,
    login?: string
): Promise<ServerKeysView> {
    const connection = await getHostConnection(hostId, ownerId);
    const self = connection.username;
    let logins: ServerLogin[] = [{ name: self, self: true }];
    if (connection.sudo) {
        const listing = await run(connection, LIST_LOGINS);
        // macOS numbers people from 501, Linux from 1000.
        const minUid = /\/Users\//.test(listing.out) ? 500 : 1000;
        logins = loginsFrom(listing.out, self, minUid);
    }
    const chosen = login && logins.some((entry) => entry.name === login) ? login : self;
    const target = await connectionFor(hostId, ownerId, chosen);
    // Polaris's key only keeps Polaris in on the login it signs in as.
    const own = chosen === self ? polarisBlob(connection) : null;
    const keys = parseAuthorizedKeys(await readFile(target, chosen), own);
    return { logins, root: connection.sudo, login: chosen, keys };
}

/** Add keys to a login. Keys already there are skipped, not doubled. */
export async function addServerKeys(
    hostId: string,
    ownerId: string,
    login: string,
    lines: string[]
): Promise<{ added: number; fingerprints: string[] }> {
    const connection = await connectionFor(hostId, ownerId, login);
    const before = await readFile(connection, login);
    const next = withKeys(before, lines);
    if (next.added > 0) await writeFile(connection, login, before, next.text);
    const fingerprints = lines
        .map((line) => parseAuthorizedKeyLine(normalizeSshPublicKey(line))?.fingerprint)
        .filter((value): value is string => Boolean(value));
    return { added: next.added, fingerprints };
}

/** Take a key away from a login. Polaris's own key is refused: removing it is
 *  removing the server from Polaris, which has its own, explained, button. */
export async function removeServerKey(
    hostId: string,
    ownerId: string,
    login: string,
    fingerprint: string
): Promise<void> {
    const connection = await connectionFor(hostId, ownerId, login);
    const before = await readFile(connection, login);
    const own = login === connection.username ? polarisBlob(connection) : null;
    const keys = parseAuthorizedKeys(before, own);
    const key = keys.find((entry) => entry.fingerprint === fingerprint);
    if (!key) throw new ServerKeysError("notFound");
    if (key.polaris) throw new ServerKeysError("protectedKey");
    await writeFile(connection, login, before, withoutKey(before, fingerprint));
}

/** Mint a pair, install the public half, and hand the private half back once. */
export async function generateServerKey(
    hostId: string,
    ownerId: string,
    login: string,
    label: string
): Promise<{ privateKey: string; publicKey: string; fingerprint: string }> {
    const comment = (label || `${login}@polaris`).replace(/\s+/g, "-");
    const pair = generateSshKeyPair(comment);
    await addServerKeys(hostId, ownerId, login, [pair.publicKey]);
    const parsed = parseAuthorizedKeyLine(pair.publicKey);
    return { privateKey: pair.privateKey, publicKey: pair.publicKey, fingerprint: parsed?.fingerprint ?? "" };
}

const githubKeysSchema = z.array(z.object({ id: z.number(), key: z.string().max(16_384) })).max(100);

export interface GithubKeyAccount {
    login: string;
    keys: Array<{ key: string; fingerprint: string; type: string }>;
    /** GitHub could not be asked for this account. */
    failed: boolean;
}

/** The public keys on each GitHub account this person linked. Null when they
 *  have linked none, which the panel answers with where to link one. */
export async function githubKeys(userId: string): Promise<GithubKeyAccount[] | null> {
    const credentials = await githubCredentialsForUser(userId);
    if (credentials.length === 0) return null;
    const accounts: GithubKeyAccount[] = [];
    for (const credential of credentials) {
        try {
            const response = await fetch(
                `https://api.github.com/users/${encodeURIComponent(credential.login)}/keys`,
                {
                    headers: {
                        Accept: "application/vnd.github+json",
                        Authorization: `Bearer ${credential.token}`,
                        "X-GitHub-Api-Version": "2022-11-28"
                    },
                    signal: AbortSignal.timeout(10_000)
                }
            );
            if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
            const listed = githubKeysSchema.parse(await response.json());
            const keys = listed.flatMap((entry) => {
                const parsed = parseAuthorizedKeyLine(entry.key);
                return parsed ? [{ key: `${parsed.type} ${parsed.blob}`, fingerprint: parsed.fingerprint, type: parsed.type }] : [];
            });
            accounts.push({ login: credential.login, keys, failed: false });
        } catch {
            accounts.push({ login: credential.login, keys: [], failed: true });
        }
    }
    return accounts;
}
