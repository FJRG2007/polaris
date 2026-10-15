/**
 * Credentials a provider insists on and Polaris never uses.
 *
 * Some providers refuse to create a machine without a root password or an
 * administrator key. Polaris reaches the machine through the login its
 * enrollment provisions, so what is handed over here is generated, given to the
 * provider once, and forgotten: the private half of the key and the password
 * are never stored or shown.
 */

import { generateKeyPairSync, randomBytes } from "node:crypto";

/** An OpenSSH `ssh-rsa` public key line for a key whose private half is
 *  discarded. RSA because it is the type every provider accepts. */
export function throwawaySshKey(comment = "polaris-unused"): string {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
    const jwk = publicKey.export({ format: "jwk" });
    return opensshRsaLine(
        Buffer.from(jwk.e ?? "", "base64url"),
        Buffer.from(jwk.n ?? "", "base64url"),
        comment
    );
}

/** RFC 4253 section 6.6: string "ssh-rsa", mpint e, mpint n. */
export function opensshRsaLine(e: Buffer, n: Buffer, comment: string): string {
    const blob = Buffer.concat([
        sshString(Buffer.from("ssh-rsa")),
        sshString(mpint(e)),
        sshString(mpint(n))
    ]);
    return `ssh-rsa ${blob.toString("base64")} ${comment}`;
}

function sshString(data: Buffer): Buffer {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, data]);
}

/** A positive integer in two's complement: a leading zero byte when the top
 *  bit is set. */
function mpint(bytes: Buffer): Buffer {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    const trimmed = bytes.subarray(start);
    return (trimmed[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed;
}

/** A long random password with every character class a provider may demand. */
export function throwawayPassword(): string {
    return `Pl${randomBytes(24).toString("base64url")}9!`;
}
