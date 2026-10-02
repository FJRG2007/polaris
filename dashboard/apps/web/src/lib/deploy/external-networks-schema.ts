/**
 * The shape of the networks of the operator's own a service joins, read by the
 * form that edits them and by the server that saves them - one schema, so the
 * two can never disagree about what is a valid name. See `external-networks`.
 */

import { z } from "zod";

/** Docker's own and Polaris's own: joining one would put a service where it must
 *  not be (Polaris's database network) or where nothing can be joined. */
const RESERVED = new Set(["bridge", "host", "none", "ingress", "docker_gwbridge"]);

/** A Docker network name, as the daemon and compose take it. */
const networkName = z
    .string()
    .trim()
    .min(1, "issues.networkName")
    .max(64, "issues.networkName")
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, "issues.networkName")
    .refine((name) => !RESERVED.has(name) && !name.toLowerCase().startsWith("polaris"), {
        message: "issues.networkReserved"
    });

/** A name another container can resolve: one DNS label. */
const alias = z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "issues.networkAlias")
    .max(63, "issues.networkAlias")
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "issues.networkAlias");

export const externalNetworkSchema = z.object({
    name: networkName,
    aliases: z.array(alias).max(8, "issues.networkTooMany").default([])
});

export const externalNetworksSchema = z
    .array(externalNetworkSchema)
    .max(8, "issues.networkTooMany")
    .refine((list) => new Set(list.map((entry) => entry.name)).size === list.length, {
        message: "issues.networkTwice"
    })
    .transform((list) => list.map((entry) => ({ name: entry.name, aliases: [...new Set(entry.aliases)] })));

export type ExternalNetwork = z.infer<typeof externalNetworkSchema>;
