/**
 * Docker connection schemas. A connection is a transport plus its non-secret
 * config; like storage connections, secret material (a pasted private key or TLS
 * certs for remote hosts) is encrypted at rest and never returned to the client.
 * The common local case - reaching the host Engine over the install-provisioned
 * SSH key - carries no stored secret at all: it references the mounted key file.
 */

import { z } from "zod";

export const DOCKER_TRANSPORTS = ["socket", "ssh", "tcp"] as const;
export type DockerTransport = (typeof DOCKER_TRANSPORTS)[number];

export const dockerConfigSchema = z.discriminatedUnion("transport", [
    z.object({
        transport: z.literal("socket"),
        socketPath: z.string().default("/var/run/docker.sock")
    }),
    z.object({
        transport: z.literal("ssh"),
        host: z.string().min(1),
        port: z.number().int().positive().max(65535).default(22),
        username: z.string().min(1),
        // Use the install-provisioned key (POLARIS_SSH_KEY) instead of a stored
        // one. This is the default, secret-free path for the local host.
        useInstallKey: z.boolean().default(true)
    }),
    z.object({
        transport: z.literal("tcp"),
        host: z.string().min(1),
        port: z.number().int().positive().max(65535).default(2375),
        tls: z.boolean().default(false)
    })
]);

export type DockerConfig = z.infer<typeof dockerConfigSchema>;

// Secret material. Empty for socket and install-key SSH; populated only for
// remote SSH with a pasted key or TLS-secured TCP.
export const dockerCredentialsSchema = z.discriminatedUnion("transport", [
    z.object({ transport: z.literal("socket") }),
    z.object({ transport: z.literal("ssh"), privateKey: z.string().optional(), passphrase: z.string().optional() }),
    z.object({ transport: z.literal("tcp"), ca: z.string().optional(), cert: z.string().optional(), key: z.string().optional() })
]);

export type DockerCredentials = z.infer<typeof dockerCredentialsSchema>;

export const createDockerConnectionSchema = z.object({
    name: z.string().min(1).max(120),
    config: dockerConfigSchema,
    credentials: dockerCredentialsSchema
});

export type CreateDockerConnectionInput = z.infer<typeof createDockerConnectionSchema>;
