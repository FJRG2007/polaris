/**
 * Ed25519 key pairs for the logins Polaris provisions on a machine it enrolls.
 *
 * Enrollment never asks anybody to hand Polaris a password or an existing key:
 * Polaris mints the pair, keeps the private half (envelope-encrypted, like every
 * other stored credential), and the enrollment script installs only the public
 * half. Nothing secret travels to the machine, and nothing secret comes back.
 *
 * Node can generate the key but not write it the way SSH reads it, so the two
 * OpenSSH encodings are built here: the `ssh-ed25519 AAAA...` line for
 * authorized_keys, and the unencrypted `openssh-key-v1` container ssh2 parses.
 * Both formats are byte-for-byte what ssh-keygen produces, minus the passphrase -
 * the key is only ever at rest inside Polaris's encrypted credential store.
 */

import { generateKeyPairSync } from "node:crypto";

/** The `openssh-key-v1` blocksize for the unencrypted ("none" cipher) case. */
const PAD_BLOCK = 8;

/** How wide OpenSSH wraps the base64 body of a private key. */
const PEM_WIDTH = 70;

/** The armour label OpenSSH puts around the container. */
const PEM_LABEL = "OPENSSH PRIVATE KEY";

export interface SshKeyPair {
    /** One authorized_keys line: `ssh-ed25519 <base64> <comment>`. */
    readonly publicKey: string;
    /** An unencrypted OpenSSH private key, ready for ssh2's `parseKey`. */
    readonly privateKey: string;
}

/** Length-prefixed field, the one primitive every SSH wire structure is built of. */
function field(value: Buffer | string): Buffer {
    const body = typeof value === "string" ? Buffer.from(value) : value;
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    return Buffer.concat([length, body]);
}

function uint32(value: number): Buffer {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(value);
    return buffer;
}

/**
 * Generate a key pair. `comment` is what shows up at the end of the
 * authorized_keys line, so an operator reading the file on their own server can
 * tell which Polaris put it there.
 */
export function generateSshKeyPair(comment: string): SshKeyPair {
    const pair = generateKeyPairSync("ed25519");
    // The raw 32-byte halves sit at the tail of the DER encodings; ed25519 keys
    // are fixed-size, so this is exact rather than a heuristic.
    const publicRaw = pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
    const seed = pair.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32);
    const publicBlob = Buffer.concat([field("ssh-ed25519"), field(publicRaw)]);

    return {
        publicKey: `ssh-ed25519 ${publicBlob.toString("base64")} ${comment}`,
        privateKey: encodePrivateKey(publicBlob, publicRaw, seed, comment)
    };
}

/**
 * Wrap the key halves in the `openssh-key-v1` container with no cipher and no
 * KDF. The two identical check integers are what OpenSSH compares after
 * decrypting to tell a wrong passphrase from a right one; with no cipher they are
 * a formality, but the parser still verifies they match.
 */
function encodePrivateKey(publicBlob: Buffer, publicRaw: Buffer, seed: Buffer, comment: string): string {
    const check = uint32(0x504f_4c52);
    const secret = Buffer.concat([
        check,
        check,
        field("ssh-ed25519"),
        field(publicRaw),
        // OpenSSH stores the private half as seed || public, not the seed alone.
        field(Buffer.concat([seed, publicRaw])),
        field(comment)
    ]);
    // Padding counts up from 1, so a truncated key is detectable rather than
    // silently accepted with a shorter comment.
    const padding = (PAD_BLOCK - (secret.length % PAD_BLOCK)) % PAD_BLOCK;
    const padded = Buffer.concat([
        secret,
        Buffer.from(Array.from({ length: padding }, (_, index) => index + 1))
    ]);

    const container = Buffer.concat([
        Buffer.from("openssh-key-v1\0"),
        field("none"),
        field("none"),
        field(Buffer.alloc(0)),
        uint32(1),
        field(publicBlob),
        field(padded)
    ]);

    const body = container.toString("base64").replace(new RegExp(`(.{${PEM_WIDTH}})`, "g"), "$1\n");
    const lines = body.endsWith("\n") ? body : `${body}\n`;
    const rule = "-".repeat(5);
    return `${rule}BEGIN ${PEM_LABEL}${rule}\n${lines}${rule}END ${PEM_LABEL}${rule}\n`;
}

/**
 * The base64 body of an `ssh-<type> <base64> [comment]` line, which is the form a
 * host key is pinned in. Returns null for anything that is not one, so a key
 * reported by a machine is validated before it is trusted as a pin.
 */
export function publicKeyBlob(line: string): string | null {
    const [type, blob] = line.trim().split(/\s+/);
    if (!type || !blob) return null;
    if (!/^(ssh-|ecdsa-|sk-)/.test(type)) return null;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) return null;
    // The blob restates its own algorithm in its first field. Checking it agrees
    // with the declared type is what separates a real key from any string that
    // happens to be spelled in the base64 alphabet.
    const decoded = Buffer.from(blob, "base64");
    if (decoded.length < 4) return null;
    const nameLength = decoded.readUInt32BE(0);
    if (nameLength > decoded.length - 4) return null;
    if (decoded.subarray(4, 4 + nameLength).toString() !== type) return null;
    return blob;
}
