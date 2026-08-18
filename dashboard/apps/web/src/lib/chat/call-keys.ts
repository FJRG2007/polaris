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

import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

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

/**
 * Read the pair, or mint it.
 *
 * Idempotent, and the reason it is safe to call on every boot: a file that is
 * already there is read rather than replaced. Replacing it would invalidate
 * every token in flight and, worse, leave the media server signing with one
 * secret and the dashboard with another until the container next restarted.
 *
 * @param seed - a secret this deployment already used, from an install that
 *   predates the file. Adopted rather than replaced, so an update does not change
 *   the key of a deployment whose calls were working.
 */
export async function ensureCallKey(seed?: string): Promise<CallKey | null> {
    const existing = await readCallKey();
    if (existing) return existing;

    const apiSecret = seed?.trim() || randomBytes(32).toString("base64");
    const key: CallKey = { apiKey: CALL_API_KEY, apiSecret };
    try {
        // The mode matters: LiveKit refuses a key file anybody else can read, and
        // the refusal is a container that will not start rather than a warning.
        await writeFile(callKeyFile(), render(key), { encoding: "utf8", mode: 0o600 });
    } catch (error) {
        // A deployment with no such volume - a dev run outside compose - has no
        // media server either, and the screens say so. Not worth an exception.
        console.error(
            "polaris: could not write the call server key:",
            error instanceof Error ? error.message : error
        );
        return null;
    }
    return key;
}

/** The pair on disk, or null when there is not one yet. */
export async function readCallKey(): Promise<CallKey | null> {
    const text = await readFile(callKeyFile(), "utf8").catch(() => null);
    return text === null ? null : parse(text);
}

/** `name: secret`, which is the shape LiveKit reads. One pair: this file exists
 *  so that two containers agree on one key, and a second would be a second
 *  answer to that question. */
function render(key: CallKey): string {
    return `${key.apiKey}: ${key.apiSecret}\n`;
}

/** The first `name: secret` line, or null when the file is not one. Parsed by
 *  hand rather than with a YAML library: it is one line this module wrote, and a
 *  parser for it is smaller than the argument for adding a dependency. */
function parse(text: string): CallKey | null {
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const at = trimmed.indexOf(":");
        if (at < 0) return null;
        const apiKey = trimmed.slice(0, at).trim();
        const apiSecret = trimmed.slice(at + 1).trim();
        return apiKey && apiSecret ? { apiKey, apiSecret } : null;
    }
    return null;
}
