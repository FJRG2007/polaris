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
import { isCarrierGradeNat, isIpAddress, isPrivateIp } from "../cidr.js";

export const SSH_AUTH_METHODS = ["password", "key"] as const;
export type SshAuthMethod = (typeof SSH_AUTH_METHODS)[number];

/**
 * The id the box Polaris runs on carries wherever a server is picked. It has no
 * Host row - there are no credentials to store for the machine serving the
 * request - so this literal stands in for one, as it already does in Deploy and
 * the marketplace.
 */
export const LOCAL_SERVER_ID = "local";

/** A server picker's value: the local box, or a registered Host's id. */
export const serverIdSchema = z.union([z.literal(LOCAL_SERVER_ID), z.string().uuid()], {
    errorMap: () => ({ message: "Choose a server" })
});

/**
 * Where a server physically lives. This is not cosmetic: it decides how a domain
 * can be pointed at the server and whether it can serve public traffic at all.
 * - `home-nat`   : home/office LAN behind a router; inbound needs port forwarding.
 * - `home-cgnat` : home line behind carrier NAT; no inbound port exists, so public
 *                  access is only possible through an outbound tunnel.
 * - `vps`        : VPS or dedicated server holding its own public address.
 * - `cloud`      : cloud VM (AWS/GCP/Azure...); public address plus a firewall or
 *                  security group that must allow 80/443.
 * - `unknown`    : not detected and not answered yet.
 */
export const SERVER_ENVIRONMENTS = ["home-nat", "home-cgnat", "vps", "cloud", "unknown"] as const;
export type ServerEnvironment = (typeof SERVER_ENVIRONMENTS)[number];
export const serverEnvironmentSchema = z.enum(SERVER_ENVIRONMENTS);

/** Coarse grouping of the environments, for copy and defaults that only care
 *  whether a server sits on a home line or in a data centre. */
export type ServerEnvironmentGroup = "home" | "datacenter" | "unknown";

export function serverEnvironmentGroup(environment: ServerEnvironment): ServerEnvironmentGroup {
    if (environment === "home-nat" || environment === "home-cgnat") return "home";
    if (environment === "vps" || environment === "cloud") return "datacenter";
    return "unknown";
}

/**
 * Best guess from an address alone: carrier-NAT space is a home line with no
 * inbound ports, any other private address a home/office LAN box, a public one a
 * server that already holds its own address. A hostname says nothing, so it stays
 * unknown and the operator is asked.
 */
export function environmentFromAddress(address: string): ServerEnvironment {
    if (isCarrierGradeNat(address)) return "home-cgnat";
    if (!isIpAddress(address.trim())) return "unknown";
    return isPrivateIp(address) ? "home-nat" : "vps";
}

/** Non-secret host configuration, safe to store in the clear and show in the UI. */
export const hostConfigSchema = z.object({
    address: z.string().min(1),
    port: z.number().int().positive().max(65535).default(22),
    username: z.string().min(1),
    authMethod: z.enum(SSH_AUTH_METHODS),
    environment: serverEnvironmentSchema.default("unknown"),
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

/** Payload for (re)classifying where a server lives. A null `hostId` targets the
 *  box Polaris itself runs on, which has no Host row. */
export const setServerEnvironmentSchema = z.object({
    hostId: z.string().uuid().nullable(),
    environment: serverEnvironmentSchema
});

export type SetServerEnvironmentInput = z.infer<typeof setServerEnvironmentSchema>;

/** Payload for renaming a server. A null `hostId` targets the box Polaris runs
 *  on, whose name is a setting rather than a Host row; blank clears it back to
 *  the machine's own name. */
export const renameServerSchema = z.object({
    hostId: z.string().uuid().nullable(),
    name: z.string().trim().max(120)
});

export type RenameServerInput = z.infer<typeof renameServerSchema>;

/**
 * Payload for taking a server out of Polaris. `disconnect` only forgets it;
 * `clean` also stops what Polaris deployed there and takes its login back off the
 * machine; `move` puts the services on another server first, and is the only mode
 * that needs a destination - "local" for the box Polaris runs on, or another
 * server's id.
 */
export const removeServerSchema = z
    .object({
        mode: z.enum(["disconnect", "clean", "move"]),
        destinationId: z.string().trim().min(1).max(64).optional()
    })
    .refine((value) => value.mode !== "move" || Boolean(value.destinationId), {
        message: "Choose where the services should move to",
        path: ["destinationId"]
    });

export type RemoveServerInput = z.infer<typeof removeServerSchema>;
