/**
 * Who can sign in to a server with a key: the inputs for listing, adding and
 * removing the lines of a login's `authorized_keys`, and for minting a new pair.
 *
 * The login name ends up as an argument to a script run on the server, so it is
 * held to the portable POSIX user-name set rather than accepted as free text. A
 * key is one `type base64 [comment]` line; anything that would add a second line
 * to the file - a newline smuggled into a comment - is refused here, before the
 * server is ever asked.
 */

import { z } from "zod";

/** A login on the server: lower case, digits, `_` and `-`, 32 characters at most. */
export const serverLoginSchema = z
    .string()
    .trim()
    .regex(/^[a-z_][a-z0-9_-]{0,31}$/, "Not a login on this server");

/** The key types OpenSSH accepts in `authorized_keys`. */
const KEY_TYPE = /^(ssh-ed25519|ssh-rsa|ssh-dss|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)$/;

/** Normalize a pasted key: one line, single spaces, nothing around it. */
export function normalizeSshPublicKey(value: string): string {
    return value.trim().replace(/[ \t]+/g, " ");
}

/** One public key as pasted. Options before the type are not accepted from the
 *  form: they change what the key may do and are not something to paste blind. */
export const sshPublicKeySchema = z
    .string()
    .transform(normalizeSshPublicKey)
    .pipe(
        z
            .string()
            .min(1, "Paste a public key")
            .max(16_384, "That key is too long")
            .refine((line) => !/[\r\n\0]/.test(line), "Paste one key per line")
            .refine((line) => {
                const [type, blob] = line.split(" ");
                return Boolean(type && blob && KEY_TYPE.test(type) && /^[A-Za-z0-9+/]+={0,2}$/.test(blob));
            }, "That is not an SSH public key")
            .refine((line) => !/PRIVATE KEY/.test(line), "That is a private key. Paste the public one")
    );

export const serverKeysTargetSchema = z.object({
    hostId: z.string().uuid("Choose a server"),
    login: serverLoginSchema
});

export const addServerKeysSchema = serverKeysTargetSchema.extend({
    keys: z.array(sshPublicKeySchema).min(1, "Paste a public key").max(50)
});
export type AddServerKeysInput = z.infer<typeof addServerKeysSchema>;

export const removeServerKeySchema = serverKeysTargetSchema.extend({
    fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/, "Not a key fingerprint")
});
export type RemoveServerKeyInput = z.infer<typeof removeServerKeySchema>;

export const generateServerKeySchema = serverKeysTargetSchema.extend({
    // Shown at the end of the line on the server, so it is held to one plain line.
    label: z
        .string()
        .trim()
        .max(64)
        .regex(/^[A-Za-z0-9@._ -]*$/, "Use letters, digits, spaces and . _ - @")
        .default("")
});
export type GenerateServerKeyInput = z.infer<typeof generateServerKeySchema>;
