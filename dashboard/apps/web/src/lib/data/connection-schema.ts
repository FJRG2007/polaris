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
 */

import { z } from "zod";
import { DB_ENGINES } from "@polaris/core";

/** A hostname or an address, not a URL: a whole connection string pasted here
 *  silently produces a host nothing resolves. */
const hostname = (what: string) =>
    z
        .string()
        .trim()
        .min(1, `Give the address of the ${what}.`)
        .max(253, "That address is too long.")
        .refine((value) => !/[\s/@]/.test(value), "Enter a hostname or an IP address, without the rest of a URL.");

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

const uuid = (message: string) => z.string().uuid(message);

export const SSH_AUTH_METHODS = ["password", "key"] as const;
export type SshAuthMethod = (typeof SSH_AUTH_METHODS)[number];

/**
 * How the database is reached, when it is not reached directly.
 *
 * Through a server already registered in Servers, whose login and pinned key are
 * reused; or through an SSH login typed here, optionally reached through a
 * registered server acting as a bastion.
 */
export const sshTunnelSchema = z.discriminatedUnion("mode", [
    z.object({
        mode: z.literal("server"),
        hostId: uuid("Pick the server to tunnel through.")
    }),
    z.object({
        mode: z.literal("manual"),
        host: hostname("SSH server"),
        port: port.default(22),
        username: z.string().trim().min(1, "Enter the SSH user.").max(64, "That user is too long."),
        authMethod: z.enum(SSH_AUTH_METHODS),
        password: optionalSecret(1024),
        privateKey: optionalSecret(16_384),
        passphrase: optionalSecret(1024),
        jumpHostId: uuid("Pick the server to jump through.").nullish().transform((value) => value ?? null)
    })
]);

export type SshTunnelInput = z.input<typeof sshTunnelSchema>;
export type SshTunnel = z.output<typeof sshTunnelSchema>;

export const saveConnectionSchema = z
    .object({
        id: uuid("That connection is not there any more.").nullish().transform((value) => value ?? null),
        name: z.string().trim().min(1, "Give the connection a name.").max(80, "That name is too long."),
        engine: z.enum(DB_ENGINES, { errorMap: () => ({ message: "Unknown engine." }) }),
        managedDatabaseId: uuid("Pick a database.").nullish().transform((value) => value ?? null),
        host: z.string().trim().max(253).nullish(),
        port: port.nullish(),
        database: optionalText(128),
        username: optionalText(128),
        password: optionalSecret(1024),
        tls: z.boolean().default(false),
        // Off unless ticked: the choice is the reader's, made in the form.
        readOnly: z.boolean().default(false),
        ssh: sshTunnelSchema.nullish().transform((value) => value ?? null)
    })
    .superRefine((value, context) => {
        if (value.managedDatabaseId) return;
        const ssh = value.ssh;
        if (ssh?.mode === "manual" && ssh.authMethod === "key" && ssh.passphrase && !ssh.privateKey) {
            context.addIssue({
                code: "custom",
                path: ["ssh", "passphrase"],
                message: "Paste the private key this passphrase is for, or clear the passphrase."
            });
        }
        const host = hostname("database").safeParse(value.host ?? "");
        if (!host.success) {
            context.addIssue({ code: "custom", path: ["host"], message: host.error.issues[0]!.message });
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
