/**
 * The key the dashboard and the media server sign with, on a volume they share.
 *
 * It used to travel through `.env`, and that was the whole bug: `.env` is only
 * ever written by the installer, an installed Polaris is only ever updated from
 * the button in Settings, and in the limited edition nothing reconciles `.env` at
 * all. So a deployment that had never re-run a script had no key, no media
 * server, and a settings screen telling its owner to go and configure something
 * Polaris was supposed to set up for them.
 *
 * A file fixes it because both containers can reach it: the dashboard mints it on
 * startup if it is not there, and the media server reads it as its `key_file`.
 * Nothing to reconcile, nothing to type, and it repairs itself on every boot.
 *
 * LiveKit will not read a key file that is readable by anybody else - it checks
 * the `others` permission bits are zero - so this is written 0600. Its own image
 * runs as root, which reads that regardless of who owns it; the dashboard runs as
 * `node`, which is why the mount point is created for that user in the
 * Dockerfile rather than left to Docker, who would hand it to root.
 *
 * Server-only.
 */

import { join } from "node:path";
import { loadEnv } from "@polaris/config";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

/** The volume both containers mount. */
function keysDir(): string {
    return process.env.POLARIS_CALL_KEYS_DIR ?? "/call-keys";
}

/** The file LiveKit is pointed at by `key_file` in the compose config. */
export function callKeyFile(): string {
    return join(keysDir(), "keys.yaml");
}

/** What the shipped media server knows this Polaris as. A name rather than a
 *  secret: it travels in every token and identifies the key, nothing more. */
export const CALL_API_KEY = "polaris";

/** A pair the media server will accept. */
export interface CallKey {
    readonly apiKey: string;
    readonly apiSecret: string;
}

/** How long a failure stands before the file is tried again. Every screen with a
 *  call button asks where calls run, so without this a deployment with no volume
 *  writes a log line per render and buries everything else in it. */
const RETRY_AFTER_MS = 30_000;

let cached: { file: string; key: CallKey } | null = null;
let missed: { file: string; at: number } | null = null;
let inflight: { file: string; work: Promise<CallKey | null> } | null = null;

/** Throw the cached pair away. For a test asserting what is on disk rather than
 *  what this module already answered; nothing in the app calls it, since the file
 *  is written once and never changes under a running process. */
export function forgetCallKey(): void {
    cached = null;
    missed = null;
    inflight = null;
}

/**
 * Read the pair, or mint it.
 *
 * Idempotent, and the reason it is safe to call on every boot and on every
 * request: a file that is already there is read rather than replaced. Replacing
 * it would invalidate every token in flight and, worse, leave the media server
 * signing with one secret and the dashboard with another until the container
 * next restarted.
 *
 * The answer is held for the life of the process, because this is on the path of
 * every screen that draws a call button and the file cannot change underneath a
 * running one: whoever wrote it wrote it once.
 */
export async function ensureCallKey(): Promise<CallKey | null> {
    const file = callKeyFile();
    if (cached?.file === file) return cached.key;
    if (missed?.file === file && Date.now() - missed.at < RETRY_AFTER_MS) return null;
    if (inflight?.file !== file) inflight = { file, work: resolve(file) };
    return inflight.work;
}

async function resolve(file: string): Promise<CallKey | null> {
    const key = (await read(file)) ?? (await mint(file));
    if (key) {
        cached = { file, key };
        missed = null;
    } else {
        missed = { file, at: Date.now() };
    }
    if (inflight?.file === file) inflight = null;
    return key;
}

/**
 * Write a pair nobody has written yet.
 *
 * Created exclusively rather than written over, because two web containers is
 * the ordinary case during an update - the rollout raises the new one beside the
 * old - and both starting against an empty volume would otherwise mint two
 * different secrets, of which the media server accepts one. The loser reads back
 * what the winner wrote and the two agree.
 */
async function mint(file: string): Promise<CallKey | null> {
    const key = adopted() ?? minted();
    if (await write(file, key, "wx")) return key;

    const raced = await read(file);
    if (raced) return raced;
    // Not a race, then: what is there is not a pair at all, which is a file to
    // replace rather than one to adopt. Left alone it would be a deployment
    // whose calls never work again and nothing on the machine that repairs it.
    return (await write(file, key, "w")) ? key : null;
}

/** A pair for a deployment that has never had one. LiveKit logs a secret under
 *  32 characters as an error, and a short one is a signing key worth guessing. */
function minted(): CallKey {
    return { apiKey: CALL_API_KEY, apiSecret: randomBytes(32).toString("base64") };
}

async function write(file: string, key: CallKey, flag: "w" | "wx"): Promise<boolean> {
    try {
        // The mode matters: LiveKit refuses a key file anybody else can read, and
        // the refusal is a container that will not start rather than a warning.
        await writeFile(file, render(key), { encoding: "utf8", mode: 0o600, flag });
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return false;
        // A deployment with no such volume - a dev run outside compose - has no
        // media server either, and the screens say so. Not worth an exception.
        console.error(
            "polaris: could not write the call server key:",
            error instanceof Error ? error.message : error
        );
        return false;
    }
}

/**
 * The pair an install predating the file was already using, out of the
 * environment its installer wrote.
 *
 * Adopted rather than replaced, so an update does not change the key of a
 * deployment whose calls were working - including one whose compose file is
 * older than the image it runs, where the media server is still keyed from
 * `.env` and would refuse every token signed with a new secret.
 *
 * Both halves, not only the secret: the name travels in the token and the
 * installer let it be set.
 */
function adopted(): CallKey | null {
    const env = loadEnv();
    const apiSecret = env.POLARIS_CALL_SERVER_API_SECRET?.trim();
    if (!apiSecret) return null;
    // An install that aliased the two carries one value in both, and this file is
    // read by another container: seeding it would hand that container the secret
    // every session is signed with. install.sh separates them, but it only runs
    // from a script, and the whole point of this file is a deployment that never
    // runs one.
    if (apiSecret === env.POLARIS_AUTH_SECRET?.trim()) return null;
    // A whole address names somebody else's server, so that is their key rather
    // than this stack's, and it does not belong on this volume. The shipped
    // server gets one of its own.
    const url = env.POLARIS_CALL_SERVER_URL?.trim();
    if (url && !url.startsWith("/")) return null;
    return { apiKey: env.POLARIS_CALL_SERVER_API_KEY?.trim() || CALL_API_KEY, apiSecret };
}

/** The pair on disk, or null when there is not one yet. */
export async function readCallKey(): Promise<CallKey | null> {
    return read(callKeyFile());
}

async function read(file: string): Promise<CallKey | null> {
    const text = await readFile(file, "utf8").catch(() => null);
    return text === null ? null : parse(text);
}

/**
 * `name: secret`, which is the shape LiveKit reads. One pair: this file exists
 * so that two containers agree on one key, and a second would be a second answer
 * to that question.
 *
 * Both halves quoted, because the far side is a real YAML parser and an adopted
 * secret is whatever an operator put in `.env`: one starting with `*` or `&` is
 * an alias there, one starting with `@` is reserved outright, and one carrying
 * ` #` ends early. Each of those fails silently - both sides believe they hold a
 * key and every token is refused at the media server.
 */
function render(key: CallKey): string {
    return `${quote(key.apiKey)}: ${quote(key.apiSecret)}\n`;
}

function quote(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function unquote(value: string): string {
    if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
    return value.slice(1, -1).replace(/\\(["\\])/g, "$1");
}

/** A `name: secret` line, quoted or not. */
const PAIR = /^("(?:[^"\\]|\\.)*"|[^:]*?)\s*:\s*(.*)$/;

/** The first pair in the file, or null when the file is not one. Parsed by hand
 *  rather than with a YAML library: it is one line this module wrote, and a
 *  parser for it is smaller than the argument for adding a dependency. */
function parse(text: string): CallKey | null {
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const match = PAIR.exec(trimmed);
        if (!match) return null;
        const apiKey = unquote(match[1]!.trim());
        const apiSecret = unquote(match[2]!.trim());
        return apiKey && apiSecret ? { apiKey, apiSecret } : null;
    }
    return null;
}
