/**
 * The containers a database laid out over several is deployed as.
 *
 * Which containers there are and what each one starts with is decided in
 * `@polaris/core` (`database-topology`); this turns that into the members of a
 * deploy plan - who gets the engine's first-start account, who gets the
 * cluster's key, which one is published - so `deployDatabase` hands the driver
 * one plan whatever the layout. Pure: a test reads exactly what a layout
 * deploys.
 */

import type { DbMemberPlan } from "@polaris/deploy";
import {
    mongoMemberCommand,
    mysqlMemberCommand,
    readHostName,
    topologyMembers,
    MONGO_KEY_ENV,
    type DbTopology
} from "@polaris/core";

export interface TopologyPlanInput {
    readonly topology: DbTopology;
    /** The instance's own container name - its first member's. */
    readonly name: string;
    /** The instance's own data volume, which its first member keeps; the others'
     *  are named after it, so an upgrade that moves the instance onto a new
     *  volume moves every member with it. */
    readonly volumeName: string;
    /** What a single instance of the engine is started with: the account its
     *  image creates on first start. */
    readonly engineEnv: Readonly<Record<string, string>>;
    /** The instance's administrative password - MySQL's root password. */
    readonly password: string;
    /** The key MongoDB members authenticate each other with. */
    readonly clusterKey?: string;
    readonly exposePort?: number;
    /** Members already moved to another image by a rolling upgrade, by name. */
    readonly memberImages?: Readonly<Record<string, string>>;
}

/**
 * The members of a deploy plan for a layout, or undefined for a single
 * instance, which is deployed as the one container it always was.
 *
 * - A replica set's first member gets the engine's first-start account, so
 *   it alone has data before the set is initiated; the manual's initiation
 *   refuses members that already hold data, and the rest receive the account
 *   by replication.
 * - A sharded cluster's members get no first-start account at all: the
 *   cluster's account is created through the router once the config servers
 *   answer (see `ensureTopology`), where the manual creates it.
 * - A MySQL replica gets the root password alone. The image writes its
 *   database and account through the binary log on the primary; a replica
 *   that created them itself would stop on the primary's statements that
 *   create them again.
 */
export function topologyMemberPlans(input: TopologyPlanInput): DbMemberPlan[] | undefined {
    const { topology, name } = input;
    if (topology.kind === "single") return undefined;
    const members = topologyMembers(topology, name);
    const volumeOf = (suffix: string | null) => (suffix === null ? undefined : `${input.volumeName}${suffix}`);
    const imageOf = (member: string) => input.memberImages?.[member];

    if (topology.kind === "replicas") {
        return members.map((member, index) => ({
            name: member.name,
            env: index === 0 ? { ...input.engineEnv } : { MYSQL_ROOT_PASSWORD: input.password },
            command: mysqlMemberCommand(index + 1),
            volumeName: volumeOf(member.volumeSuffix),
            ...(index === 0 && input.exposePort !== undefined ? { exposePort: input.exposePort } : {}),
            ...(index === 0 ? {} : { aliases: [readHostName(name)] }),
            ...(imageOf(member.name) ? { image: imageOf(member.name) } : {})
        }));
    }

    if (!input.clusterKey) throw new Error("This database's cluster key is missing, so its members could not sign in to each other");
    const key = { [MONGO_KEY_ENV]: input.clusterKey };
    return members.map((member, index) => ({
        name: member.name,
        env: topology.kind === "replicaSet" && index === 0 ? { ...input.engineEnv, ...key } : key,
        command: mongoMemberCommand(member, topology, name),
        volumeName: volumeOf(member.volumeSuffix),
        // What is published is what clients connect to: a cluster's router. A
        // replica set is never published - see the create schema.
        ...(member.role === "router" && input.exposePort !== undefined ? { exposePort: input.exposePort } : {}),
        ...(imageOf(member.name) ? { image: imageOf(member.name) } : {})
    }));
}
