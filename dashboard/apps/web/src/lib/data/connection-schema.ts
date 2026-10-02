/**
 * What a saved database connection may be, checked the same way in the form and
 * on the server.
 *
 * The form validates against this as somebody types, and the server parses the
 * request with it before anything is stored - so a value the server would refuse
 * is refused in the form first, in the same words, and nothing the browser sends
 * is trusted for having come from that form.
 *
 * Secrets are optional on purpose: an edit that leaves a password or a key empty
 * keeps the stored one, and the server decides whether there is one to keep.
 *
 * What can be told from the text alone - a public key pasted where the private
 * one goes, a key locked with a passphrase, a private key uploaded as a
 * certificate - is told here, so the form says it before anything is sent. The
 * server then parses the key and the certificates for real (`ssh-key.ts`,
 * `connections.ts`), which no shape check replaces.
 */

import { z } from "zod";
import { DB_ENGINES } from "@polaris/core";

/** Labels of a hostname, or an address: a whole connection string pasted here
 *  silently produces a host nothing resolves, and a `?` or a `,` would be read
 *  as part of a MongoDB connection string. */
const HOST_SHAPE =
    /^(?:\[[0-9A-Fa-f:.]+\]|[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*|[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?(?:\.[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?)*\.?)$/;

const hostname = (what: string) =>
    z
        .string()
        .trim()
        .min(1, `Give the address of the ${what}.`)
        .max(253, "That address is too long.")
        .refine(
            (value) => HOST_SHAPE.test(value),
            "Enter a hostname or an IP address, without the rest of a URL."
        );

const port = z
    .number({ invalid_type_error: "That is not a port." })
    .int("That is not a port.")
    .min(1, "That is not a port.")
    .max(65535, "That is not a port.");

/** Blank and absent are the same answer: nothing typed. */
const optionalText = (max: number) =>
    z
        .string()
        .trim()
        .max(max, "That is too long.")
        .nullish()
        .transform((value) => (value ? value : null));

/** A secret is taken as typed - a password may start or end with a space. */
const optionalSecret = (max: number) =>
    z
        .string()
        .max(max, "That is too long.")
        .nullish()
        .transform((value) => (value ? value : null));

/** A file's worth of text: trimmed, since a stray newline is not part of a PEM. */
const optionalFile = (max: number) =>
    z
        .string()
        .max(max, "That file is too large.")
        .nullish()
        .transform((value) => (value?.trim() ? value.trim() : null));

const uuid = (message: string) => z.string().uuid(message);

export const SSH_AUTH_METHODS = ["password", "key"] as const;
export type SshAuthMethod = (typeof SSH_AUTH_METHODS)[number];

/** libpq's `sslmode` names, which every client uses (see `tls.ts`). */
export const TLS_MODES = ["disable", "require", "verify-ca", "verify-full"] as const;
export type TlsMode = (typeof TLS_MODES)[number];

/** Whether `next` protects the connection less than `saved` did. A stored
 *  secret is only sent over a channel at least as safe as it was saved for. */
export function weakerTls(saved: TlsMode, next: TlsMode): boolean {
    return TLS_MODES.indexOf(next) < TLS_MODES.indexOf(saved);
}

/**
 * Where a verifying connection's trusted authority comes from: the public ones
 * every system trusts, a certificate uploaded here, or the server's own
 * certificate, trusted the first time it is seen and checked every time after.
 */
export const TLS_TRUST = ["system", "upload", "server"] as const;
export type TlsTrust = (typeof TLS_TRUST)[number];

/** The largest private key or certificate the form takes. A 16384-bit RSA key in
 *  PEM is under 13 KB; a CA bundle of a dozen certificates is under 64 KB. */
export const MAX_KEY_BYTES = 16_384;
export const MAX_CERT_BYTES = 65_536;

/** What a pasted key looks like before anything parses it. */
export type KeyShape =
    | {
          readonly kind: "private";
          readonly format: "openssh" | "pem" | "pkcs8" | "ppk";
          readonly encrypted: boolean;
      }
    | { readonly kind: "public" }
    | { readonly kind: "unknown" };

/**
 * The format of a key, from its text. Pure and the same in the browser and on
 * the server, so the form can ask for a passphrase the moment a locked key is
 * dropped in, and point out a public key before anybody saves it.
 */
export function sshKeyShape(text: string): KeyShape {
    const key = text.trim();
    if (
        /^(?:ssh-(?:rsa|dss|ed25519)|ecdsa-sha2-nistp\d+|sk-[\w@.-]+)\s+AAAA/.test(key) ||
        /^-----BEGIN (?:RSA |SSH2 )?PUBLIC KEY-----/.test(key) ||
        /^---- BEGIN SSH2 PUBLIC KEY ----/.test(key)
    ) {
        return { kind: "public" };
    }
    if (/^PuTTY-User-Key-File-[23]:/.test(key)) {
        const encryption = /^Encryption:\s*(\S+)/m.exec(key)?.[1] ?? "none";
        return { kind: "private", format: "ppk", encrypted: encryption !== "none" };
    }
    if (/^-----BEGIN OPENSSH PRIVATE KEY-----/.test(key)) {
        return { kind: "private", format: "openssh", encrypted: opensshCipher(key) !== "none" };
    }
    const pem = /^-----BEGIN (RSA|EC|DSA|ENCRYPTED|) ?PRIVATE KEY-----/.exec(key);
    if (pem) {
        const kind = pem[1];
        if (kind === "") return { kind: "private", format: "pkcs8", encrypted: false };
        if (kind === "ENCRYPTED") return { kind: "private", format: "pkcs8", encrypted: true };
        return { kind: "private", format: "pem", encrypted: /Proc-Type:\s*4,ENCRYPTED/.test(key) };
    }
    return { kind: "unknown" };
}

/** The cipher an OpenSSH key names in its header, or "none". Read with `atob`,
 *  which both the browser and Node have. */
function opensshCipher(key: string): string {
    const body = key
        .replace(/-----(?:BEGIN|END) OPENSSH PRIVATE KEY-----/g, "")
        .replace(/\s+/g, "");
    let bytes: string;
    try {
        bytes = atob(body.slice(0, 120));
    } catch {
        return "none";
    }
    const magic = "openssh-key-v1\0";
    if (!bytes.startsWith(magic)) return "none";
    const at = magic.length;
    const length =
        (bytes.charCodeAt(at) << 24) |
        (bytes.charCodeAt(at + 1) << 16) |
        (bytes.charCodeAt(at + 2) << 8) |
        bytes.charCodeAt(at + 3);
    return bytes.slice(at + 4, at + 4 + Math.min(length, 64)) || "none";
}

/** The refusals a key's shape earns, said once for the form and the server. */
export const KEY_REFUSALS = {
    publicKey: "That is a public key. Use the private key - the file without .pub.",
    unknown: "That is not a private key Polaris can read. Use an OpenSSH, PEM or PuTTY key.",
    locked: "This key is locked with a passphrase. Enter it below."
} as const;

const CERT_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/;

/** A certificate file: at least one certificate and no private key in it. */
function certificateIssue(text: string | null): string | null {
    if (!text) return null;
    if (/PRIVATE KEY-----/.test(text)) {
        return "That file holds a private key. Use the certificate here.";
    }
    return CERT_BLOCK.test(text) ? null : "That is not a PEM certificate.";
}

/**
 * How the database is reached, when it is not reached directly.
 *
 * Through a server already registered in Servers, whose login and pinned key are
 * reused; or through an SSH login typed here, optionally reached through a
 * registered server acting as a bastion.
 */
export const sshTunnelSchema = z.discriminatedUnion("mode", [
    z
        .object({
            mode: z.literal("server"),
            hostId: uuid("Pick the server to tunnel through.")
        })
        .strict(),
    z
        .object({
            mode: z.literal("manual"),
            host: hostname("SSH server"),
            port: port.default(22),
            username: z
                .string()
                .trim()
                .min(1, "Enter the SSH user.")
                .max(64, "That user is too long."),
            authMethod: z.enum(SSH_AUTH_METHODS),
            password: optionalSecret(1024),
            privateKey: optionalSecret(MAX_KEY_BYTES),
            passphrase: optionalSecret(1024),
            jumpHostId: uuid("Pick the server to jump through.")
                .nullish()
                .transform((value) => value ?? null)
        })
        .strict()
]);

export type SshTunnelInput = z.input<typeof sshTunnelSchema>;
export type SshTunnel = z.output<typeof sshTunnelSchema>;

export const saveConnectionSchema = z
    .object({
        id: uuid("That connection is not there any more.")
            .nullish()
            .transform((value) => value ?? null),
        name: z
            .string()
            .trim()
            .min(1, "Give the connection a name.")
            .max(80, "That name is too long."),
        // i18n-ignore said in the reader's words by lib/data/words
        engine: z.enum(DB_ENGINES, { errorMap: () => ({ message: "Unknown engine." }) }),
        managedDatabaseId: uuid("Pick a database.")
            .nullish()
            .transform((value) => value ?? null),
        host: z.string().trim().max(253).nullish(),
        port: port.nullish(),
        database: optionalText(128),
        username: optionalText(128),
        password: optionalSecret(1024),
        tlsMode: z.enum(TLS_MODES).default("disable"),
        tlsTrust: z.enum(TLS_TRUST).default("system"),
        tlsCaCert: optionalFile(MAX_CERT_BYTES),
        tlsClientCert: optionalFile(MAX_CERT_BYTES),
        tlsClientKey: optionalSecret(MAX_KEY_BYTES),
        // Present a client certificate. Off clears a stored one.
        tlsClientAuth: z.boolean().default(false),
        // Off unless ticked: the choice is the reader's, made in the form.
        readOnly: z.boolean().default(false),
        ssh: sshTunnelSchema.nullish().transform((value) => value ?? null)
    })
    .strict()
    .superRefine((value, context) => {
        if (value.managedDatabaseId) return;
        const ssh = value.ssh;
        if (ssh?.mode === "manual" && ssh.authMethod === "key") {
            if (ssh.passphrase && !ssh.privateKey) {
                context.addIssue({
                    code: "custom",
                    path: ["ssh", "passphrase"],
                    // i18n-ignore said in the reader's words by lib/data/words
                    message:
                        "Paste the private key this passphrase is for, or clear the passphrase."
                });
            }
            if (ssh.privateKey) {
                const shape = sshKeyShape(ssh.privateKey);
                const message =
                    shape.kind === "public"
                        ? KEY_REFUSALS.publicKey
                        : shape.kind === "unknown"
                          ? KEY_REFUSALS.unknown
                          : shape.encrypted && !ssh.passphrase
                            ? KEY_REFUSALS.locked
                            : null;
                if (message)
                    context.addIssue({ code: "custom", path: ["ssh", "privateKey"], message });
            }
        }
        const host = hostname("database").safeParse(value.host ?? "");
        if (!host.success) {
            context.addIssue({
                code: "custom",
                path: ["host"],
                message: host.error.issues[0]!.message
            });
        }
        for (const field of ["tlsCaCert", "tlsClientCert"] as const) {
            const issue = certificateIssue(value[field]);
            if (issue) context.addIssue({ code: "custom", path: [field], message: issue });
        }
        if (
            value.tlsClientKey &&
            !/-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(value.tlsClientKey)
        ) {
            context.addIssue({
                code: "custom",
                path: ["tlsClientKey"],
                // i18n-ignore said in the reader's words by lib/data/words
                message: "That is not a PEM private key."
            });
        } else if (value.tlsClientKey && /ENCRYPTED/.test(value.tlsClientKey)) {
            context.addIssue({
                code: "custom",
                path: ["tlsClientKey"],
                // i18n-ignore said in the reader's words by lib/data/words
                message:
                    "This key is locked with a passphrase. Save a copy without one and use that file."
            });
        }
        // A certificate and its key are replaced together: one without the other
        // cannot be presented, and pairing a new one with an old one never works.
        if (value.tlsClientCert && !value.tlsClientKey) {
            context.addIssue({
                code: "custom",
                path: ["tlsClientKey"],
                // i18n-ignore said in the reader's words by lib/data/words
                message: "Add the key that goes with this certificate."
            });
        }
        if (value.tlsClientKey && !value.tlsClientCert) {
            context.addIssue({
                code: "custom",
                path: ["tlsClientCert"],
                // i18n-ignore said in the reader's words by lib/data/words
                message: "Add the certificate that goes with this key."
            });
        }
    });

export type SaveConnectionInput = z.input<typeof saveConnectionSchema>;
export type ParsedConnection = z.output<typeof saveConnectionSchema>;

/**
 * The first thing wrong with each field, keyed by its path ("ssh.host"), for a
 * form to draw under the field it belongs to.
 */
export function connectionIssues(input: SaveConnectionInput): Record<string, string> {
    const parsed = saveConnectionSchema.safeParse(input);
    if (parsed.success) return {};
    const issues: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
        const key = issue.path.join(".");
        issues[key] ??= issue.message;
    }
    return issues;
}

/**
 * Whether a host is a name on the public internet, which is where a verified
 * certificate is the norm and the form starts on `verify-full`. An address, a
 * single-label name and the private suffixes are not: a certificate for one of
 * those is rarely from a public authority.
 */
export function looksPublic(host: string): boolean {
    const name = host.trim().toLowerCase().replace(/\.$/, "");
    if (!name.includes(".")) return false;
    if (/^[\d.]+$/.test(name) || name.includes(":")) return false;
    return !/\.(?:local|lan|internal|home|corp|localdomain|localhost|test|intranet|home\.arpa)$/.test(
        name
    );
}
