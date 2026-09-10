/**
 * A Redis Cluster run as one managed database: every node's command, and the
 * steps that join the nodes into a cluster once they all answer.
 *
 * The nodes are containers on the database's own network, reached by name. Two
 * things follow from that. `CLUSTER MEET` - which `redis-cli --cluster create`
 * sends - takes an IP address, never a name, so the names are resolved to the
 * addresses they have now (`getent`, which the Alpine images carry) right
 * before the cluster is created. And a container can come back from a redeploy
 * on a different address, so every later run introduces each node again at the
 * address it has now; a node the cluster already knows keeps its identity, which
 * lives in `nodes.conf` on its own volume.
 *
 * Clients are sent to other nodes by name (`cluster-announce-hostname` with the
 * hostname endpoint type), so a redirect names a container the services beside
 * the cluster can resolve, and never an address that changes under them.
 *
 * Pure: these build commands and scripts and run nothing. Node names reach the
 * scripts as positional arguments (`"$@"`, the first node first), never
 * interpolated into them.
 */

import type { TemplatePrepareStep } from "../service-templates.js";
import { redisServerCommand, type RedisMode } from "./database-maintenance.js";

/** The port every node serves clients on. The cluster bus is this plus 10000. */
export const REDIS_CLUSTER_PORT = 6379;

/** How long a node may be unreachable before its replica takes over, in ms. The
 *  value Redis' own cluster tutorial starts from. */
export const REDIS_CLUSTER_NODE_TIMEOUT_MS = 5000;

/** A container name as a node is given it: what DNS and Redis both accept as a
 *  hostname. Checked so nothing else ever reaches an announced hostname. */
const NODE_NAME = /^[a-z0-9](?:[a-z0-9.-]{0,62})$/;

/** The nodes a cluster of `masters` runs: one replica for each master. */
export function redisClusterNodeCount(masters: number): number {
    return masters * 2;
}

/**
 * The `redis-server` command for one node: the mode's own command, plus the
 * cluster settings. `masterauth` is the same password as `requirepass`, so a
 * replica - and a master that has been failed over and comes back as one - can
 * authenticate to whichever node it replicates.
 */
export function redisClusterServerCommand(
    password: string,
    mode: RedisMode,
    maxMemoryMb: number | undefined,
    hostname: string
): string[] {
    if (!NODE_NAME.test(hostname)) throw new Error(`${hostname} cannot be announced as a cluster node's hostname`);
    return [
        ...redisServerCommand(password, mode, maxMemoryMb),
        "--masterauth",
        password,
        "--cluster-enabled",
        "yes",
        // Written into the working directory, /data, which is the node's volume:
        // a node that restarts keeps its identity and what it knows of the rest.
        "--cluster-config-file",
        "nodes.conf",
        "--cluster-node-timeout",
        String(REDIS_CLUSTER_NODE_TIMEOUT_MS),
        "--cluster-announce-hostname",
        hostname,
        "--cluster-preferred-endpoint-type",
        "hostname"
    ];
}

/** Every node answers PING, asked from the first node by name. */
const EVERY_NODE_ANSWERS = `for n in "$@"; do [ "$(redis-cli --no-auth-warning -h "$n" -p ${REDIS_CLUSTER_PORT} PING 2>&1)" = PONG ] || exit 1; done`;

/**
 * Create the cluster, or - when the first node already knows others - introduce
 * every node again at the address it has now. The addresses are resolved first
 * either way: `CLUSTER MEET` takes an IP address.
 */
const CREATE_OR_INTRODUCE = [
    'first="$1"',
    'addrs=""',
    "for n in \"$@\"; do ip=$(getent hosts \"$n\" | awk '$1 ~ /^[0-9.]+$/ { print $1; exit }'); if [ -z \"$ip\" ]; then echo \"$n has no address on this network\"; exit 1; fi; addrs=\"$addrs $ip\"; done",
    `known=$(redis-cli --no-auth-warning -h "$first" -p ${REDIS_CLUSTER_PORT} CLUSTER INFO | sed -n 's/^cluster_known_nodes:\\([0-9]*\\).*$/\\1/p')`,
    `if [ "\${known:-0}" -gt 1 ]; then for ip in $addrs; do [ "$(redis-cli --no-auth-warning -h "$first" -p ${REDIS_CLUSTER_PORT} CLUSTER MEET "$ip" ${REDIS_CLUSTER_PORT})" = OK ] || { echo "The node at $ip could not be introduced"; exit 1; }; done; echo "The cluster already exists; every node was introduced again at its current address."; exit 0; fi`,
    `set --; for ip in $addrs; do set -- "$@" "$ip:${REDIS_CLUSTER_PORT}"; done`,
    "exec redis-cli --no-auth-warning --cluster create \"$@\" --cluster-replicas 1 --cluster-yes"
].join("; ");

/**
 * The cluster answers queries (`cluster_state:ok`) and knows every node. Read
 * from the first node; a cluster that has only just been created takes a few
 * seconds of gossip to get there.
 */
function clusterSettled(nodes: number): string {
    return [
        `info=$(redis-cli --no-auth-warning -h "$1" -p ${REDIS_CLUSTER_PORT} CLUSTER INFO | tr -d '\\r')`,
        'echo "$info" | grep -qx "cluster_state:ok"',
        `echo "$info" | grep -qx "cluster_known_nodes:${nodes}"`
    ].join(" && ");
}

/**
 * The steps that bring a cluster of `masters` up, for `runPrepareSteps` - the
 * same sequencer a template's setup runs through. Each script is run in the
 * first node's container with every node's name as its positional arguments,
 * the first node first, and the password in `REDISCLI_AUTH` (`redisClusterExec`).
 *
 * Safe to run after every deploy: an existing cluster is never created again.
 */
export function redisClusterSetupSteps(masters: number): TemplatePrepareStep[] {
    return [
        {
            title: "Creating the cluster",
            command: CREATE_OR_INTRODUCE,
            // A first deploy pulls the image and starts every node; three minutes.
            readiness: { test: EVERY_NODE_ANSWERS, intervalMs: 2000, retries: 90 }
        },
        {
            title: "Checking the cluster",
            command: `redis-cli --no-auth-warning -h "$1" -p ${REDIS_CLUSTER_PORT} CLUSTER INFO | grep '^cluster_'`,
            readiness: { test: clusterSettled(redisClusterNodeCount(masters)), intervalMs: 2000, retries: 60 }
        }
    ];
}

/**
 * The argv one setup script runs as: through `sh` with the nodes as positional
 * arguments, and the password in the environment variable redis-cli reads, so
 * it is never part of the script.
 */
export function redisClusterExec(password: string, script: string, nodes: readonly string[]): string[] {
    for (const node of nodes) {
        if (!NODE_NAME.test(node)) throw new Error(`${node} is not a cluster node's name`);
    }
    return ["env", `REDISCLI_AUTH=${password}`, "sh", "-c", script, "polaris", ...nodes];
}

/** The seed list a cluster client is given: every node as `host:port`. */
export function redisClusterSeeds(nodes: readonly string[]): string[] {
    return nodes.map((node) => `${node}:${REDIS_CLUSTER_PORT}`);
}
