"use client";

/**
 * How a new database is laid out, in the new-database form: a MongoDB instance
 * as one container, a replica set or a sharded cluster; a MySQL one with or
 * without read replicas. Only shown for the engines that have a choice, and
 * only for an instance of its own - a database placed on an existing instance
 * runs the way that instance does.
 *
 * The value is the create request's own fields, so the form validates it with
 * the same schema the server does.
 */

import * as core from "@polaris/core";
import type { ReactNode } from "react";
import { SegmentedControl, Select } from "@polaris/ui";

export type TopologyValue = Pick<
    core.DatabaseCreateInput,
    "topology" | "members" | "shards" | "readReplicas"
>;

export const SINGLE_TOPOLOGY: TopologyValue = { topology: "single" };

/** True when an engine offers more than one layout. */
export function hasTopologyChoice(engine: string): boolean {
    return engine === "mongo" || engine === "mysql";
}

export function DatabaseTopologyField({
    engine,
    value,
    onChange
}: {
    engine: string;
    value: TopologyValue;
    onChange: (value: TopologyValue) => void;
}) {
    const topology = core.topologyOf(value);

    if (engine === "mysql") {
        const replicas = topology.kind === "replicas" ? topology.replicas : 0;
        return (
            <Group
                label="Read replicas"
                hint={
                    replicas > 0
                        ? "They follow the primary by GTID replication and refuse writes. The connection details gain a URI for reading from them."
                        : "Just the primary."
                }
            >
                <SegmentedControl
                    aria-label="Read replicas"
                    value={String(replicas)}
                    onValueChange={(next) =>
                        onChange(
                            next === "0"
                                ? SINGLE_TOPOLOGY
                                : { topology: "replicas", readReplicas: Number(next) }
                        )
                    }
                    options={[
                        { value: "0", label: "None" },
                        ...core.MYSQL_REPLICA_COUNTS.map((count) => ({
                            value: String(count),
                            label: String(count)
                        }))
                    ]}
                />
            </Group>
        );
    }

    if (engine !== "mongo") return null;
    const containers =
        topology.kind === "sharded"
            ? core.MONGO_CLUSTER_SET_SIZE + topology.shards * core.MONGO_CLUSTER_SET_SIZE + 1
            : topology.kind === "replicaSet"
              ? topology.members
              : 1;
    return (
        <Group
            label="Layout"
            hint={
                topology.kind === "replicaSet"
                    ? `${containers} members on this server, finding each other by name. Connection strings list them all.`
                    : topology.kind === "sharded"
                      ? `A config server set of ${core.MONGO_CLUSTER_SET_SIZE}, ${topology.shards} shards of ${core.MONGO_CLUSTER_SET_SIZE} members and a router: ${containers} containers. Each collection stays on one shard until your application shards it with a shard key (shardCollection). Backups and version changes are not offered for it yet.`
                      : "One container."
            }
        >
            <SegmentedControl
                aria-label="Layout"
                value={topology.kind === "replicas" ? "single" : topology.kind}
                onValueChange={(next) =>
                    onChange(
                        next === "replicaSet"
                            ? { topology: "replicaSet", members: core.MONGO_SET_SIZES[0] }
                            : next === "sharded"
                              ? { topology: "sharded", shards: core.MONGO_SHARD_COUNTS[0] }
                              : SINGLE_TOPOLOGY
                    )
                }
                options={[
                    { value: "single", label: "Single" },
                    { value: "replicaSet", label: "Replica set" },
                    { value: "sharded", label: "Sharded" }
                ]}
            />
            {topology.kind === "replicaSet" ? (
                <SegmentedControl
                    aria-label="Members"
                    size="sm"
                    value={String(topology.members)}
                    onValueChange={(next) =>
                        onChange({ topology: "replicaSet", members: Number(next) })
                    }
                    options={core.MONGO_SET_SIZES.map((count) => ({
                        value: String(count),
                        label: `${count} members`
                    }))}
                />
            ) : null}
            {topology.kind === "sharded" ? (
                <div className="w-40">
                    <Select
                        value={String(topology.shards)}
                        onValueChange={(next) =>
                            onChange({ topology: "sharded", shards: Number(next) })
                        }
                        options={core.MONGO_SHARD_COUNTS.map((count) => ({
                            value: String(count),
                            label: `${count} shards`
                        }))}
                    />
                </div>
            ) : null}
        </Group>
    );
}

function Group({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
    return (
        <div role="group" aria-label={label} className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{label}</span>
            <div className="flex flex-wrap items-center gap-2">{children}</div>
            <span className="text-xs text-muted-foreground/70">{hint}</span>
        </div>
    );
}
