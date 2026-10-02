/**
 * A private key, as somebody pasted or dropped it, turned into one ssh2 signs in
 * with - or a sentence saying why it cannot be.
 *
 * ssh2 reads OpenSSH keys, the older PEM ones (`BEGIN RSA PRIVATE KEY`, `EC`,
 * `DSA`) and PuTTY's version-2 RSA files. What people actually have also
 * includes PKCS#8 (`BEGIN PRIVATE KEY`, which OpenSSL and most cloud consoles
 * hand out) and PuTTY files of any type in either version. Those are converted
 * here, once, into an unencrypted OpenSSH key - which is then stored the way every
 * other secret in Polaris is, sealed with the master key - so the connection code
 * only ever meets the formats ssh2 already reads.
 *
 * Every key is parsed before it is accepted, and the parsed key has to sign
 * something and verify its own signature: a key that converted without complaint
 * but does not match its public half is refused here rather than at the SSH
 * server.
 *
 * Server-only.
 */

import * as crypto from "node:crypto";
import { parseKey, type ParsedKey } from "@polaris/ssh";
import { KEY_REFUSALS, sshKeyShape } from "./connection-schema";

/** A key ready to sign in with. */
export interface ReadKey {
    /** The key text to store: as given, or converted to OpenSSH. */
    readonly privateKey: string;
    /** The passphrase still needed to use it - null once it was converted, since
     *  the converted key is stored unencrypted inside Polaris' own envelope. */
    readonly passphrase: string | null;
    /** "ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256"... */
    readonly type: string;
    /** OpenSSH's form: "SHA256:" and the base64 digest of the public key. */
    readonly fingerprint: string;
    /** Whether it was converted from PKCS#8 or PuTTY. */
    readonly converted: boolean;
}

export class SshKeyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SshKeyError";
    }
}

export const SSH_KEY_REFUSALS = {
    ...KEY_REFUSALS,
    wrongPassphrase: "That passphrase does not unlock this key.",
    unsupported: "Polaris cannot use this kind of key. Use an Ed25519, ECDSA or RSA key.",
    tooCostly: "This key asks for more work to unlock than Polaris allows. Save it again with fewer KDF rounds (100 or less).",
    newPutty:
        "This PuTTY key is locked in PuTTY's newer format, which Polaris cannot unlock. In PuTTYgen, export it as an OpenSSH key, or save it with no passphrase, and use that file."
} as const;

/** OpenSSH's default is 16 and `ssh-keygen -a 100` is the usual "stronger". A
 *  file is attacker-chosen input, and bcrypt rounds are CPU on this server. */
const MAX_KDF_ROUNDS = 100;

/**
 * Read a private key, converting it when ssh2 cannot read it as it is.
 * Throws `SshKeyError` with a sentence for the form.
 */
export function readPrivateKey(text: string, passphrase: string | null): ReadKey {
    const key = text.trim();
    const shape = sshKeyShape(key);
    if (shape.kind === "public") throw new SshKeyError(SSH_KEY_REFUSALS.publicKey);
    if (shape.kind === "unknown") throw new SshKeyError(SSH_KEY_REFUSALS.unknown);
    if (shape.encrypted && !passphrase) throw new SshKeyError(SSH_KEY_REFUSALS.locked);

    if (shape.format === "openssh") assertAffordable(key);

    if (shape.format === "ppk") {
        const converted = opensshFromPpk(key, passphrase);
        return finish(converted, null, true);
    }
    if (shape.format === "pkcs8") {
        return finish(opensshFromPkcs8(key, passphrase), null, true);
    }
    return finish(key, shape.encrypted ? passphrase : null, false);
}

function finish(privateKey: string, passphrase: string | null, converted: boolean): ReadKey {
    const parsed = parseWithSsh2(privateKey, passphrase);
    const probe = Buffer.from("polaris key check");
    const signature: Buffer | Error = parsed.sign(probe);
    if (signature instanceof Error || parsed.verify(probe, signature) !== true) {
        throw new SshKeyError(SSH_KEY_REFUSALS.unknown);
    }
    const blob = parsed.getPublicSSH();
    const digest = crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
    return { privateKey, passphrase, type: parsed.type, fingerprint: `SHA256:${digest}`, converted };
}

function parseWithSsh2(privateKey: string, passphrase: string | null): ParsedKey {
    const result = parseKey(privateKey, passphrase ?? undefined);
    if (result instanceof Error) throw new SshKeyError(ssh2Refusal(result.message));
    // ssh2 hands back a list for a file holding several keys; the first is used.
    const parsed: ParsedKey | undefined = Array.isArray(result) ? result[0] : result;
    if (!parsed || !parsed.isPrivateKey()) throw new SshKeyError(SSH_KEY_REFUSALS.unknown);
    return parsed;
}

function ssh2Refusal(message: string): string {
    if (/no passphrase given/i.test(message)) return SSH_KEY_REFUSALS.locked;
    if (/bad passphrase|integrity check failed/i.test(message)) return SSH_KEY_REFUSALS.wrongPassphrase;
    if (/unsupported/i.test(message)) return SSH_KEY_REFUSALS.unsupported;
    return SSH_KEY_REFUSALS.unknown;
}

/* --------------------------------------------------------------------------
 * OpenSSH's own format, read just far enough to see the KDF's cost.
 * ----------------------------------------------------------------------- */

function opensshBytes(key: string): Buffer {
    return Buffer.from(
        key.replace(/-----(?:BEGIN|END) OPENSSH PRIVATE KEY-----/g, "").replace(/\s+/g, ""),
        "base64"
    );
}

function assertAffordable(key: string): void {
    const reader = new Reader(opensshBytes(key));
    if (reader.bytes(15).toString("latin1") !== "openssh-key-v1\0") return;
    reader.string();
    const kdf = reader.string().toString("latin1");
    const options = new Reader(reader.string());
    if (kdf !== "bcrypt") return;
    options.string();
    if (options.uint32() > MAX_KDF_ROUNDS) throw new SshKeyError(SSH_KEY_REFUSALS.tooCostly);
}

/* --------------------------------------------------------------------------
 * The key parts of each type, and the OpenSSH file they are written into.
 * ----------------------------------------------------------------------- */

type KeyParts =
    | { readonly type: "ssh-ed25519"; readonly publicKey: Buffer; readonly seed: Buffer }
    | {
          readonly type: "ssh-rsa";
          readonly n: Buffer;
          readonly e: Buffer;
          readonly d: Buffer;
          readonly p: Buffer;
          readonly q: Buffer;
          readonly iqmp: Buffer;
      }
    | {
          readonly type: "ecdsa-sha2-nistp256" | "ecdsa-sha2-nistp384" | "ecdsa-sha2-nistp521";
          readonly curve: "nistp256" | "nistp384" | "nistp521";
          readonly point: Buffer;
          readonly d: Buffer;
      };

/** The public half, in the SSH wire format. */
function publicBlob(parts: KeyParts): Buffer {
    const out = new Writer().string(parts.type);
    if (parts.type === "ssh-ed25519") return out.string(parts.publicKey).done();
    if (parts.type === "ssh-rsa") return out.mpint(parts.e).mpint(parts.n).done();
    return out.string(parts.curve).string(parts.point).done();
}

/**
 * An unencrypted `openssh-key-v1` file, as `ssh-keygen` writes one: the public
 * blob, then a private section of two equal check words, the key's own fields,
 * a comment and padding to the cipher's block size (8 for "none").
 */
export function opensshPrivateKey(parts: KeyParts, comment = ""): string {
    const check = crypto.randomBytes(4);
    const section = new Writer().raw(check).raw(check).string(parts.type);
    if (parts.type === "ssh-ed25519") {
        section.string(parts.publicKey).string(Buffer.concat([parts.seed, parts.publicKey]));
    } else if (parts.type === "ssh-rsa") {
        section
            .mpint(parts.n)
            .mpint(parts.e)
            .mpint(parts.d)
            .mpint(parts.iqmp)
            .mpint(parts.p)
            .mpint(parts.q);
    } else {
        section.string(parts.curve).string(parts.point).mpint(parts.d);
    }
    section.string(comment);
    let length = section.length();
    for (let pad = 1; length % 8 !== 0; pad += 1, length += 1) section.raw(Buffer.from([pad]));

    const file = new Writer()
        .raw(Buffer.from("openssh-key-v1\0", "latin1"))
        .string("none")
        .string("none")
        .string(Buffer.alloc(0))
        .uint32(1)
        .string(publicBlob(parts))
        .string(section.done())
        .done()
        .toString("base64");
    const lines = file.match(/.{1,70}/g) ?? [];
    return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

/* --------------------------------------------------------------------------
 * PKCS#8, through Node's own parser.
 * ----------------------------------------------------------------------- */

const CURVES: Readonly<Record<string, "nistp256" | "nistp384" | "nistp521">> = {
    "P-256": "nistp256",
    "P-384": "nistp384",
    "P-521": "nistp521"
};

function opensshFromPkcs8(key: string, passphrase: string | null): string {
    let object: crypto.KeyObject;
    try {
        object = crypto.createPrivateKey(passphrase ? { key, passphrase } : { key });
    } catch (error) {
        const code = (error as { code?: string }).code ?? "";
        const message = (error as Error).message ?? "";
        if (/passphrase|decrypt|bad decrypt/i.test(`${code} ${message}`)) {
            throw new SshKeyError(passphrase ? SSH_KEY_REFUSALS.wrongPassphrase : SSH_KEY_REFUSALS.locked);
        }
        throw new SshKeyError(SSH_KEY_REFUSALS.unknown);
    }
    const jwk = object.export({ format: "jwk" });
    const b = (value: string | undefined) => Buffer.from(value ?? "", "base64url");
    if (jwk.kty === "OKP" && jwk.crv === "Ed25519") {
        return opensshPrivateKey({ type: "ssh-ed25519", publicKey: b(jwk.x), seed: b(jwk.d) });
    }
    if (jwk.kty === "RSA") {
        return opensshPrivateKey({
            type: "ssh-rsa",
            n: b(jwk.n),
            e: b(jwk.e),
            d: b(jwk.d),
            p: b(jwk.p),
            q: b(jwk.q),
            iqmp: b(jwk.qi)
        });
    }
    const curve = jwk.kty === "EC" ? CURVES[jwk.crv ?? ""] : undefined;
    if (curve) {
        return opensshPrivateKey({
            type: `ecdsa-sha2-${curve}`,
            curve,
            point: Buffer.concat([Buffer.from([4]), b(jwk.x), b(jwk.y)]),
            d: b(jwk.d)
        });
    }
    throw new SshKeyError(SSH_KEY_REFUSALS.unsupported);
}

/* --------------------------------------------------------------------------
 * PuTTY's .ppk, versions 2 and 3.
 * ----------------------------------------------------------------------- */

interface PpkFile {
    readonly version: 2 | 3;
    readonly algorithm: string;
    readonly encryption: string;
    readonly comment: string;
    readonly publicBlob: Buffer;
    readonly privateBlob: Buffer;
    readonly mac: Buffer;
    readonly fields: Readonly<Record<string, string>>;
}

function readPpk(text: string): PpkFile {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const fields: Record<string, string> = {};
    let version: 2 | 3 = 2;
    let algorithm = "";
    let publicBlob = Buffer.alloc(0);
    let privateBlob = Buffer.alloc(0);
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] as string;
        const match = /^([A-Za-z0-9-]+):\s?(.*)$/.exec(line);
        if (!match) continue;
        const [, name, value] = match as unknown as [string, string, string];
        const header = /^PuTTY-User-Key-File-([23])$/.exec(name);
        if (header) {
            version = header[1] === "3" ? 3 : 2;
            algorithm = value.trim();
            continue;
        }
        if (name === "Public-Lines" || name === "Private-Lines") {
            const count = Number.parseInt(value, 10);
            if (!Number.isInteger(count) || count < 0 || count > 400) {
                throw new SshKeyError(SSH_KEY_REFUSALS.unknown);
            }
            const body = Buffer.from(lines.slice(index + 1, index + 1 + count).join(""), "base64");
            if (name === "Public-Lines") publicBlob = body;
            else privateBlob = body;
            index += count;
            continue;
        }
        fields[name] = value.trim();
    }
    const mac = Buffer.from(fields["Private-MAC"] ?? "", "hex");
    if (!algorithm || publicBlob.length === 0 || privateBlob.length === 0 || mac.length === 0) {
        throw new SshKeyError(SSH_KEY_REFUSALS.unknown);
    }
    return {
        version,
        algorithm,
        encryption: fields.Encryption ?? "none",
        comment: fields.Comment ?? "",
        publicBlob,
        privateBlob,
        mac,
        fields
    };
}

/** The keys PuTTY derives from a passphrase: the cipher key and IV, and the MAC
 *  key. Version 3 uses Argon2, which this Node may not have. */
function ppkKeys(file: PpkFile, passphrase: string): { cipherKey: Buffer; iv: Buffer; macKey: Buffer } {
    if (file.version === 2) {
        const hash = (counter: number) =>
            crypto
                .createHash("sha1")
                .update(Buffer.from([0, 0, 0, counter]))
                .update(passphrase)
                .digest();
        return {
            cipherKey: Buffer.concat([hash(0), hash(1)]).subarray(0, 32),
            iv: Buffer.alloc(16),
            macKey: crypto.createHash("sha1").update("putty-private-key-file-mac-key").update(passphrase).digest()
        };
    }
    if (file.encryption === "none") {
        return { cipherKey: Buffer.alloc(0), iv: Buffer.alloc(0), macKey: Buffer.alloc(0) };
    }
    const argon2 = (crypto as unknown as { argon2Sync?: Argon2Sync }).argon2Sync;
    const flavour = (file.fields["Key-Derivation"] ?? "").toLowerCase();
    const memory = Number(file.fields["Argon2-Memory"]);
    const passes = Number(file.fields["Argon2-Passes"]);
    const parallelism = Number(file.fields["Argon2-Parallelism"]);
    // PuTTYgen's defaults are 8 MiB, a handful of passes and one lane; anything
    // far beyond them is a file built to burn this server's CPU and memory.
    if (
        !argon2 ||
        !["argon2id", "argon2i", "argon2d"].includes(flavour) ||
        !(memory > 0 && memory <= 65_536) ||
        !(passes > 0 && passes <= 32) ||
        !(memory * passes <= 262_144) ||
        !(parallelism > 0 && parallelism <= 4)
    ) {
        throw new SshKeyError(SSH_KEY_REFUSALS.newPutty);
    }
    const derived = argon2(flavour, {
        message: Buffer.from(passphrase),
        nonce: Buffer.from(file.fields["Argon2-Salt"] ?? "", "hex"),
        parallelism,
        tagLength: 80,
        memory,
        passes
    });
    return { cipherKey: derived.subarray(0, 32), iv: derived.subarray(32, 48), macKey: derived.subarray(48, 80) };
}

type Argon2Sync = (
    algorithm: string,
    parameters: {
        message: Buffer;
        nonce: Buffer;
        parallelism: number;
        tagLength: number;
        memory: number;
        passes: number;
    }
) => Buffer;

function opensshFromPpk(text: string, passphrase: string | null): string {
    const file = readPpk(text);
    const encrypted = file.encryption !== "none";
    if (encrypted && file.encryption !== "aes256-cbc") throw new SshKeyError(SSH_KEY_REFUSALS.unsupported);
    if (encrypted && !passphrase) throw new SshKeyError(SSH_KEY_REFUSALS.locked);

    const keys = ppkKeys(file, encrypted ? (passphrase as string) : "");
    let privateBlob = file.privateBlob;
    if (encrypted) {
        if (privateBlob.length % 16 !== 0) throw new SshKeyError(SSH_KEY_REFUSALS.unknown);
        const decipher = crypto.createDecipheriv("aes-256-cbc", keys.cipherKey, keys.iv);
        decipher.setAutoPadding(false);
        privateBlob = Buffer.concat([decipher.update(privateBlob), decipher.final()]);
    }

    const macData = new Writer()
        .string(file.algorithm)
        .string(file.encryption)
        .string(file.comment)
        .string(file.publicBlob)
        .string(privateBlob)
        .done();
    const mac = crypto
        .createHmac(file.version === 2 ? "sha1" : "sha256", keys.macKey)
        .update(macData)
        .digest();
    if (mac.length !== file.mac.length || !crypto.timingSafeEqual(mac, file.mac)) {
        throw new SshKeyError(encrypted ? SSH_KEY_REFUSALS.wrongPassphrase : SSH_KEY_REFUSALS.unknown);
    }

    const pub = new Reader(file.publicBlob);
    const priv = new Reader(privateBlob);
    const type = pub.string().toString("latin1");
    if (type !== file.algorithm) throw new SshKeyError(SSH_KEY_REFUSALS.unknown);

    if (type === "ssh-rsa") {
        const e = pub.string();
        const n = pub.string();
        const d = priv.string();
        const p = priv.string();
        const q = priv.string();
        const iqmp = priv.string();
        return opensshPrivateKey({ type, n, e, d, p, q, iqmp }, file.comment);
    }
    if (type === "ssh-ed25519") {
        const publicKey = pub.string();
        // PuTTY writes the 32-byte seed as an unsigned little-endian integer,
        // so a seed that ends in zero bytes comes out shorter.
        const stored = priv.string();
        if (stored.length > 32 || publicKey.length !== 32) throw new SshKeyError(SSH_KEY_REFUSALS.unknown);
        const seed = Buffer.concat([stored, Buffer.alloc(32 - stored.length)]);
        return opensshPrivateKey({ type, publicKey, seed }, file.comment);
    }
    const ecdsa = /^ecdsa-sha2-(nistp256|nistp384|nistp521)$/.exec(type);
    if (ecdsa) {
        const curve = ecdsa[1] as "nistp256" | "nistp384" | "nistp521";
        pub.string();
        const point = pub.string();
        const d = priv.string();
        return opensshPrivateKey(
            { type: type as `ecdsa-sha2-${typeof curve}`, curve, point, d },
            file.comment
        );
    }
    throw new SshKeyError(SSH_KEY_REFUSALS.unsupported);
}

/* --------------------------------------------------------------------------
 * The SSH wire format: uint32 lengths, strings and mpints.
 * ----------------------------------------------------------------------- */

class Reader {
    private at = 0;
    constructor(private readonly buffer: Buffer) {}

    bytes(count: number): Buffer {
        if (count < 0 || this.at + count > this.buffer.length) {
            throw new SshKeyError(SSH_KEY_REFUSALS.unknown);
        }
        const out = this.buffer.subarray(this.at, this.at + count);
        this.at += count;
        return out;
    }

    uint32(): number {
        return this.bytes(4).readUInt32BE(0);
    }

    string(): Buffer {
        return this.bytes(this.uint32());
    }
}

class Writer {
    private readonly chunks: Buffer[] = [];

    raw(bytes: Buffer): this {
        this.chunks.push(bytes);
        return this;
    }

    uint32(value: number): this {
        const out = Buffer.alloc(4);
        out.writeUInt32BE(value, 0);
        return this.raw(out);
    }

    string(value: Buffer | string): this {
        const bytes = typeof value === "string" ? Buffer.from(value, "latin1") : value;
        return this.uint32(bytes.length).raw(bytes);
    }

    /** An unsigned big integer: leading zeros dropped, and one zero byte put
     *  back when the top bit is set, so it is not read as negative. */
    mpint(value: Buffer): this {
        let start = 0;
        while (start < value.length && value[start] === 0) start += 1;
        const trimmed = value.subarray(start);
        if (trimmed.length > 0 && (trimmed[0] as number) & 0x80) {
            return this.string(Buffer.concat([Buffer.from([0]), trimmed]));
        }
        return this.string(trimmed);
    }

    length(): number {
        return this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    }

    done(): Buffer {
        return Buffer.concat(this.chunks);
    }
}
