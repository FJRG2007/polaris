/**
 * Host (global server) schemas. A Host is an SSH-reachable server registered once
 * and consumed by multiple apps - Containers (Docker over SSH) and Drive (SFTP).
 * Like storage/docker connections it is split into non-secret `config` (address,
 * port, user - safe to show) and encrypted `credentials`. The pinned host key is
 * captured on add and lives in config, not as a secret.
 *
 * Auth methods: `password` and `key` (with an optional passphrase for an
 * encrypted private key). OpenSSH user certificates are intentionally not offered
 * here: the ssh2 client exposes no typed certificate field, so a cert path cannot
 * be supported without unverifiable internals - a private key covers the common
 * "key file" case.
 */

import { z } from "zod";

export const SSH_AUTH_METHODS = ["password", "key"] as const;
export type SshAuthMethod = (typeof SSH_AUTH_METHODS)[number];

/** Non-secret host configuration, safe to store in the clear and show in the UI. */
export const hostConfigSchema = z.object({
    address: z.string().min(1),
    port: z.number().int().positive().max(65535).default(22),
    username: z.string().min(1),
    authMethod: z.enum(SSH_AUTH_METHODS),
    // Server public key (base64 of the raw key blob) pinned when the host was
    // added. Absent only transiently, before the first successful test connect.
    hostKey: z.string().optional()
});

export type HostConfig = z.infer<typeof hostConfigSchema>;

/** Secret material, discriminated by auth method. Never returned to the client. */
export const hostCredentialsSchema = z.discriminatedUnion("method", [
    z.object({ method: z.literal("password"), password: z.string().min(1) }),
    z.object({
        method: z.literal("key"),
        privateKey: z.string().min(1),
        passphrase: z.string().optional()
    })
]);

export type HostCredentials = z.infer<typeof hostCredentialsSchema>;

/** Payload the add-host form/API accepts. `hostKey` is captured server-side on
 *  the trust-on-add test connect, so it is not part of the input. */
export const createHostSchema = z.object({
    name: z.string().min(1).max(120),
    config: hostConfigSchema.omit({ hostKey: true }),
    credentials: hostCredentialsSchema
});

export type CreateHostInput = z.infer<typeof createHostSchema>;
