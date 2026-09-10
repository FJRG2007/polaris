/**
 * Joining the containers of a database laid out over several, once they answer,
 * and reading how each of them is doing.
 *
 * A compose file starts the members; it cannot say "initiate this replica set
 * once all three answer" or "add these shards to the router". That is done here,
 * after every successful deploy, by running the commands `@polaris/core`
 * (`database-topology`) builds inside the members' own containers - the same
 * post-ready exec path a template's first setup uses. Every step is safe to run
 * again: a set that is initiated answers its status, a shard already added is
 * skipped, a replica already following is pointed at its primary once more.
 *
 * The order is the manual's. A replica set: every member answering, then
 * `rs.initiate` with all of them from the first. A sharded cluster: the config
 * server replica set, then each shard's, each shard given its own
 * administrative account through the localhost exception, then the cluster's
 * account created through the router and the shards added to it. MySQL: the
 * replication account on the primary, then each replica pointed at it.
 */

import * as core from "@polaris/core";
import type { RuntimePorts } from "@polaris/deploy";
import {
    DatabaseOperationError,
    instanceContext,
    lastLine,
    runStep,
    withPorts,
    type InstanceContext
} from "./ops";

/** The one thing these steps need from a server: running a command in a
 *  container by its name. */
export type TopologyRuntime = Pick<RuntimePorts, "runIn">;

/** Everything joining a layout needs to know. */
export interface TopologySetup {
    /** The instance's own container - its first member. */
    readonly name: string;
    readonly topology: core.DbTopology;
    /** The instance's administrative account: MongoDB's root account, or for
     *  MySQL root's password. */
    readonly admin: core.MongoAuth;
    /** MySQL with read replicas: the replication account's password. */
    readonly replicationPassword?: string;
}

/** How long each wait lasts and how it waits - real time in use, a clock a
 *  test turns in its tests. */
export interface Pace {
    /** A member starting to answer: a first start that initialises a data
     *  folder takes a minute. */
    readonly readyMs: number;
    /** A set electing its primary, or a replica catching up. */
    readonly settleMs: number;
    /** Between two checks. */
    readonly gapMs: number;
    now(): number;
    wait(ms: number): Promise<void>;
}

export const REAL_PACE: Pace = {
    readyMs: 3 * 60_000,
    settleMs: 2 * 60_000,
    gapMs: 2000,
    now: () => Date.now(),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
};

/** The setup of the instance a context was resolved for. */
export function topologySetup(context: InstanceContext): TopologySetup {
    return {
        name: context.container,
        topology: context.topology,
        admin: { username: context.admin.username, password: context.admin.password },
        replicationPassword: context.admin.replicationPassword
    };
}

/** How each member of an instance is doing, for its Manage panel. A single
 *  instance, or a database hosted on one, has no members to list. */
export async function databaseMembers(databaseId: string, ownerId: string): Promise<MemberState[]> {
    const context = await instanceContext(databaseId, ownerId);
    if (context.hosted || context.topology.kind === "single") return [];
    return withPorts(context, (ports) => topologyStatus(ports, topologySetup(context)));
}

/** Join the members of a layout. Nothing to do for a single instance. */
export async function ensureTopology(
    ports: TopologyRuntime,
    setup: TopologySetup,
    pace: Pace = REAL_PACE
): Promise<void> {
    switch (setup.topology.kind) {
        case "replicaSet":
            return ensureReplicaSet(ports, setup, pace);
        case "sharded":
            return ensureShardedCluster(ports, setup, pace);
        case "replicas":
            return ensureReadReplicas(ports, setup, pace);
        default:
            return;
    }
}

/**
 * A replica set: its first member is the one the image gave the root account,
 * so it is waited on signed in; the others have no users and are waited on by
 * `ping`. Then one initiation with all of them, and a wait until the first is
 * the primary - a set that has not elected refuses every write, and the first
 * thing after this may well be one.
 */
async function ensureReplicaSet(
    ports: TopologyRuntime,
    setup: TopologySetup,
    pace: Pace
): Promise<void> {
    const [set] = core.mongoSets(setup.topology, setup.name);
    if (!set) return;
    const [first, ...rest] = set.hosts;
    if (!first) return;
    await waitAnswering(ports, rest, pace);
    await waitUntil(pace, pace.readyMs, `${first} did not accept its account in time`, () =>
        succeeds(ports, first, core.mongoSignInCommand(setup.admin))
    );
    await retrying(pace, () =>
        runStep(ports, first, core.mongoSetInitiateCommand(setup.admin, set), [
            setup.admin.password
        ])
    );
    await waitPrimary(ports, first, pace);
}

/**
 * A sharded cluster, in the manual's order. Each replica set is initiated from
 * its first member - signed in when it already has an account (a run after the
 * first), through the localhost exception when it has none. A shard is then
 * given its own administrative account, so it is not left open to anything on
 * its localhost; the config servers get theirs when the cluster's account is
 * created through the router, which stores it there. Last, every shard the
 * router does not list yet is added.
 */
async function ensureShardedCluster(
    ports: TopologyRuntime,
    setup: TopologySetup,
    pace: Pace
): Promise<void> {
    const sets = core.mongoSets(setup.topology, setup.name);
    const secrets = [setup.admin.password];
    await waitAnswering(
        ports,
        sets.flatMap((set) => set.hosts),
        pace
    );
    for (const set of sets) {
        const first = set.hosts[0];
        if (!first) continue;
        const auth = (await succeeds(ports, first, core.mongoSignInCommand(setup.admin)))
            ? setup.admin
            : null;
        await retrying(pace, () =>
            runStep(ports, first, core.mongoSetInitiateCommand(auth, set), secrets)
        );
        await waitPrimary(ports, first, pace);
        if (!auth && !set.configsvr) {
            await runStep(
                ports,
                first,
                core.mongoCreateRootCommand(setup.admin, `shard ${set.name}`),
                secrets
            );
        }
    }
    await waitAnswering(ports, [setup.name], pace);
    if (!(await succeeds(ports, setup.name, core.mongoSignInCommand(setup.admin)))) {
        await retrying(pace, () =>
            runStep(
                ports,
                setup.name,
                core.mongoCreateRootCommand(setup.admin, "the cluster"),
                secrets
            )
        );
    }
    const shards = sets.filter((set) => !set.configsvr);
    await retrying(pace, () =>
        runStep(ports, setup.name, core.mongoAddShardsCommand(setup.admin, shards), secrets)
    );
}

/**
 * MySQL read replicas: the replication account on the primary, then each
 * replica pointed at it and made read-only, then a wait until every one is
 * really following - a replica that could not connect says why, and that is
 * what gets reported rather than a setup that looked finished.
 */
async function ensureReadReplicas(
    ports: TopologyRuntime,
    setup: TopologySetup,
    pace: Pace
): Promise<void> {
    const [primary, ...replicas] = core.topologyMembers(setup.topology, setup.name);
    if (!primary) return;
    const password = setup.replicationPassword;
    if (!password)
        throw new DatabaseOperationError(
            "This database's replication password is missing, so its replicas cannot follow it."
        );
    const secrets = [setup.admin.password, password];
    await waitMysql(ports, primary.name, setup.admin.password, pace);
    await retrying(pace, () =>
        runStep(
            ports,
            primary.name,
            core.mysqlReplicationUserCommand(setup.admin.password, password),
            secrets
        )
    );
    for (const replica of replicas) {
        await waitMysql(ports, replica.name, setup.admin.password, pace);
        // A replica already following - every run after its first, since the
        // source it follows is kept in its own tables - is left alone rather
        // than stopped and pointed at the same primary again.
        const [follow, readOnly] = core.mysqlFollowCommands(
            setup.admin.password,
            primary.name,
            password
        );
        if (!(await replicaState(ports, replica.name, setup.admin.password))?.following && follow) {
            await retrying(pace, () => runStep(ports, replica.name, follow, secrets));
        }
        if (readOnly) await retrying(pace, () => runStep(ports, replica.name, readOnly, secrets));
    }
    for (const replica of replicas) {
        let said: string | null = null;
        await waitUntil(
            pace,
            pace.settleMs,
            () => `${replica.name} is not following the primary${said ? `: ${said}` : ""}`,
            async () => {
                const state = await replicaState(ports, replica.name, setup.admin.password);
                said = state?.error ? lastLine(state.error, secrets) : said;
                return state?.following ?? false;
            }
        );
    }
}

// ---------------------------------------------------------------------------
// Waiting
// ---------------------------------------------------------------------------

/** True when a command exits 0 in the container. */
async function succeeds(
    ports: TopologyRuntime,
    container: string,
    command: core.MaintenanceCommand
): Promise<boolean> {
    const result = await ports.runIn(container, command.argv).catch(() => null);
    return result?.code === 0;
}

/** Check until `check` holds, or throw with `failure` once `ms` has passed. */
async function waitUntil(
    pace: Pace,
    ms: number,
    failure: string | (() => string),
    check: () => Promise<boolean>
): Promise<void> {
    const deadline = pace.now() + ms;
    for (;;) {
        if (await check()) return;
        if (pace.now() >= deadline)
            throw new DatabaseOperationError(typeof failure === "string" ? failure : failure());
        await pace.wait(pace.gapMs);
    }
}

/** Wait until every one of these MongoDB members answers `ping`. */
async function waitAnswering(
    ports: TopologyRuntime,
    hosts: readonly string[],
    pace: Pace
): Promise<void> {
    for (const host of hosts) {
        await waitUntil(pace, pace.readyMs, `${host} did not start answering in time`, () =>
            succeeds(ports, host, core.mongoPingCommand())
        );
    }
}

/** What a member is in its set right now; `other` when it does not answer. */
async function roleOf(
    ports: TopologyRuntime,
    host: string
): Promise<"primary" | "secondary" | "other"> {
    const result = await ports.runIn(host, core.mongoRoleCommand().argv).catch(() => null);
    return result?.code === 0 ? core.mongoRoleOf(result.output) : "other";
}

/** Wait until a member is its set's writable primary. */
export async function waitPrimary(
    ports: TopologyRuntime,
    host: string,
    pace: Pace = REAL_PACE
): Promise<void> {
    await waitUntil(
        pace,
        pace.settleMs,
        `The replica set ${host} belongs to did not elect it primary in time`,
        async () => (await roleOf(ports, host)) === "primary"
    );
}

/**
 * Move a replica set's members to another version one at a time, the way the
 * manual's rolling upgrade does: every secondary first, each one restarted on
 * the new version by `move` and waited on until it is back in the set, then
 * the primary asked to step down - so the set elects another before its member
 * is restarted - and moved last. The set keeps a primary throughout.
 *
 * Refused before anything moves when a member is not a healthy primary or
 * secondary: taking one down while another is already out can cost the set its
 * majority.
 */
export async function rollMembers(
    ports: TopologyRuntime,
    hosts: readonly string[],
    admin: core.MongoAuth,
    move: (member: string) => Promise<void>,
    pace: Pace = REAL_PACE
): Promise<void> {
    const roles = new Map<string, string>();
    for (const host of hosts) roles.set(host, await roleOf(ports, host));
    const unwell = hosts.filter((host) => roles.get(host) === "other");
    if (unwell.length > 0) {
        throw new DatabaseOperationError(
            `Every member has to be a healthy primary or secondary before an upgrade, and ${unwell.join(", ")} ${unwell.length === 1 ? "is" : "are"} not. Nothing was changed.`
        );
    }
    const order = [
        ...hosts.filter((host) => roles.get(host) !== "primary"),
        ...hosts.filter((host) => roles.get(host) === "primary")
    ];
    for (const member of order) {
        if ((await roleOf(ports, member)) === "primary") {
            // Its connection may close as it steps down; whether it did is read
            // from the set, not from how the command ended.
            await ports.runIn(member, core.mongoStepDownCommand(admin).argv).catch(() => null);
            await waitUntil(
                pace,
                pace.settleMs,
                `${member} did not hand the primary over in time`,
                async () => {
                    if ((await roleOf(ports, member)) === "primary") return false;
                    for (const other of hosts)
                        if (other !== member && (await roleOf(ports, other)) === "primary")
                            return true;
                    return false;
                }
            );
        }
        await move(member);
        await waitUntil(
            pace,
            pace.readyMs,
            `${member} did not come back into the set in time`,
            async () => (await roleOf(ports, member)) !== "other"
        );
    }
}

/** A MySQL replica's replication state, or null when it could not be read. */
async function replicaState(
    ports: TopologyRuntime,
    host: string,
    rootPassword: string
): Promise<ReturnType<typeof core.parseReplicaStatus> | null> {
    const result = await ports
        .runIn(host, core.mysqlReplicaStatusCommand(rootPassword).argv)
        .catch(() => null);
    return result && result.code === 0 ? core.parseReplicaStatus(result.output) : null;
}

/** Wait until a MySQL server answers as root. */
async function waitMysql(
    ports: TopologyRuntime,
    host: string,
    password: string,
    pace: Pace
): Promise<void> {
    const probe = core.readinessCommand({ engine: "mysql", username: "root", password });
    await waitUntil(pace, pace.readyMs, `${host} did not start answering in time`, () =>
        succeeds(ports, host, probe)
    );
}

/**
 * Run a step, and run it again a few times if it fails. A server that has just
 * started answering can still be finishing its first start - the images run
 * their setup on a temporary server and restart it - and a step that lands in
 * that moment fails on a connection that is about to come back.
 */
async function retrying<T>(pace: Pace, work: () => Promise<T>, attempts = 4): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
        try {
            return await work();
        } catch (error) {
            if (!(error instanceof DatabaseOperationError) || attempt >= attempts) throw error;
            await pace.wait(pace.gapMs * 5);
        }
    }
}

// ---------------------------------------------------------------------------
// How the members are doing
// ---------------------------------------------------------------------------

/** One member, as its layout's status reads it. */
export interface MemberState {
    readonly name: string;
    readonly role: core.MemberRole;
    readonly set: string | null;
    /** What it is doing, in words. */
    readonly state: string;
    readonly healthy: boolean;
}

/** MongoDB's member states, as the screen says them. */
const MONGO_STATES: Readonly<Record<string, string>> = {
    PRIMARY: "Primary",
    SECONDARY: "Secondary",
    STARTUP: "Starting",
    STARTUP2: "Copying its data",
    RECOVERING: "Catching up",
    ROLLBACK: "Rolling back",
    ARBITER: "Arbiter",
    DOWN: "Not reachable",
    REMOVED: "Removed from the set",
    UNKNOWN: "Unknown"
};

/**
 * How every member of a layout is doing, read from the members themselves:
 * each replica set's own view of its members, the router's answer, each read
 * replica's replication state. A member nothing could be read from is "Not
 * answering" rather than left out, so a set of three always lists three.
 */
export async function topologyStatus(
    ports: TopologyRuntime,
    setup: TopologySetup
): Promise<MemberState[]> {
    const members = core.topologyMembers(setup.topology, setup.name);
    const known = new Map<string, { state: string; healthy: boolean }>();

    if (setup.topology.kind === "replicaSet" || setup.topology.kind === "sharded") {
        for (const set of core.mongoSets(setup.topology, setup.name)) {
            for (const [name, state] of await setStates(ports, set, setup.admin))
                known.set(name, state);
        }
        if (setup.topology.kind === "sharded") {
            const answering = await succeeds(ports, setup.name, core.mongoPingCommand());
            known.set(setup.name, {
                state: answering ? "Routing" : "Not answering",
                healthy: answering
            });
        }
    } else if (setup.topology.kind === "replicas") {
        const [primary, ...replicas] = members;
        if (primary) {
            const probe = core.readinessCommand({
                engine: "mysql",
                username: "root",
                password: setup.admin.password
            });
            const answering = await succeeds(ports, primary.name, probe);
            known.set(primary.name, {
                state: answering ? "Primary" : "Not answering",
                healthy: answering
            });
        }
        for (const replica of replicas) {
            const state = await replicaState(ports, replica.name, setup.admin.password);
            if (!state) continue;
            known.set(replica.name, {
                state: state.following
                    ? `Following${state.lagSeconds !== null ? `, ${state.lagSeconds}s behind` : ""}`
                    : `Not following${state.error ? `: ${lastLine(state.error, [setup.admin.password])}` : ""}`,
                healthy: state.following
            });
        }
    }

    return members.map((member) => ({
        name: member.name,
        role: member.role,
        set: member.set,
        ...(known.get(member.name) ?? { state: "Not answering", healthy: false })
    }));
}

/** One replica set's view of its members, asked of each member in turn until
 *  one answers - the first may be the one that is down. */
async function setStates(
    ports: TopologyRuntime,
    set: core.MongoSet,
    admin: core.MongoAuth
): Promise<Map<string, { state: string; healthy: boolean }>> {
    for (const host of set.hosts) {
        const result = await ports
            .runIn(host, core.mongoSetStatusCommand(admin).argv)
            .catch(() => null);
        const parsed = result?.code === 0 ? core.parseSetStatus(result.output) : null;
        if (!parsed) continue;
        return new Map(
            parsed.map((member) => [
                member.name,
                {
                    state: MONGO_STATES[member.state] ?? member.state.toLowerCase(),
                    healthy:
                        member.healthy &&
                        (member.state === "PRIMARY" || member.state === "SECONDARY")
                }
            ])
        );
    }
    return new Map();
}
