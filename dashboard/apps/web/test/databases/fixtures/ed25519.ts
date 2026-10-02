/**
 * An Ed25519 key pair from ssh2's generator, without its one-in-256 bad key.
 *
 * ssh2 1.16 strips leading zero bytes from the 32-byte public half when it
 * writes the OpenSSH file (lib/keygen.js), so a key whose public half starts
 * with 0x00 comes out 31 bytes long and is - correctly - refused by
 * `readPrivateKey`. A test that parses the key would then fail at random. The
 * public line carries the same blob, so a pair is drawn again until it is whole.
 */

import { utils } from "ssh2";

/** The blob in an `ssh-ed25519` line is `string type, string key`: 4 + 11 + 4 + 32. */
const WHOLE_BLOB = 51;

/** `options` locks the key, as ssh2's own `generateKeyPairSync` does. */
export function ed25519Pair(options?: { passphrase: string; cipher: string; rounds: number }) {
    for (;;) {
        const pair = utils.generateKeyPairSync("ed25519", options);
        const blob = Buffer.from(pair.public.split(" ")[1] ?? "", "base64");
        if (blob.length === WHOLE_BLOB) return pair;
    }
}
