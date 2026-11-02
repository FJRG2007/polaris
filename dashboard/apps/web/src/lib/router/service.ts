/**
 * Turning an enrolled machine into this network's router, and reading it back.
 *
 * Everything reaches the machine over the SSH login Polaris already holds, which
 * needs root, so there is nothing to install by hand. Applying a plan can cut the
 * very connection it travels on, so it is never trusted to have worked: Polaris has
 * to come back and confirm, and a machine that hears nothing undoes the change
 * (`renderApply`).
 */

import { z } from "zod";
import * as plans from "./plan";
import { isIP } from "node:net";
import { prisma } from "@polaris/db";
import { randomUUID } from "node:crypto";
import { readProbe, type RouterReading } from "./read";
import { edgeLauncher } from "@/lib/deploy/server-edge";
import { execCommand, openSshClient } from "@polaris/ssh";
import { cidrsOverlap } from "@/lib/vpn/networks";
import { getSetting, setSetting } from "@/lib/setting-store";
import { openText, sealText } from "@/lib/tls/managed-certificates";
import { getHostConnection, type HostConnection } from "@/lib/host-service";

/** The most machines offered: the picker searches within these. */
const MACHINE_CHOICES = 1000;
/** How long Polaris keeps trying to come back, inside the machine's own timer. */
const CONFIRM_MS = 100_000;
const CONFIRM_POLL_MS = 3_000;
/** How long after sending a change Polaris waits to hear how it ended: past the
 *  machine's own timer, with room for going back to finish. */
const SETTLE_MS = (plans.ROLLBACK_SECONDS + 60) * 1000;

export type RouterRefusalCode =
    | "noRoot"
    | "unreachable"
    | "unsupported"
    | "missingPort"
    | "lineOverlap"
    | "lockout"
    | "notRadio"
    | "noPassword"
    | "rolledBack"
    | "unconfirmed"
    | "invalid";

/** A reason the screen can say in the reader's words. */
export class RouterRefusal extends Error {
    constructor(readonly code: RouterRefusalCode) {
        super(code);
        this.name = "RouterRefusal";
    }
}

export interface RouterMachine {
    readonly id: string;
    readonly name: string;
    readonly address: string;
    /** Polaris holds root here, which making it a router needs. */
    readonly root: boolean;
}

export interface RouterView {
    readonly plan: plans.RouterPlan | null;
    readonly reading: RouterReading | null;
}

async function storedPlan(hostId: string): Promise<plans.RouterPlan | null> {
    const raw = await getSetting(plans.routerPlanKey(hostId));
    if (!raw) return null;
    try {
        return plans.readPlan(JSON.parse(raw));
    } catch {
        return null;
    }
}

/** The passwords kept for a machine. Unreadable reads as none: the screen then asks for
 *  them again, rather than a machine being told a wrong one. */
async function storedSecrets(hostId: string): Promise<plans.RouterSecrets> {
    const opened = openText(await getSetting(plans.routerSecretsKey(hostId)));
    if (!opened) return {};
    try {
        const parsed: unknown = JSON.parse(opened);
        return secretsSchema.parse(parsed);
    } catch {
        return {};
    }
}

const secretsSchema = z.record(z.string(), z.string());

async function keepSecrets(hostId: string, secrets: plans.RouterSecrets): Promise<void> {
    const value = Object.keys(secrets).length > 0 ? sealText(JSON.stringify(secrets)) : null;
    await setSetting(plans.routerSecretsKey(hostId), value);
}

const queues = new Map<string, Promise<unknown>>();

/** One change at a time per machine: two at once would fight over its network. */
function serialized<T>(hostId: string, work: () => Promise<T>): Promise<T> {
    const run = (queues.get(hostId) ?? Promise.resolve()).then(work, work);
    queues.set(
        hostId,
        run.catch(() => undefined)
    );
    return run;
}

function hasRoot(connection: HostConnection): boolean {
    return connection.username === "root" || connection.sudo;
}

/** Run a script as root on the machine and hand back what it printed. */
async function runScript(connection: HostConnection, script: string): Promise<string> {
    const client = await openSshClient({
        host: connection.address,
        port: connection.port,
        username: connection.username,
        auth: connection.auth,
        pinnedHostKey: connection.hostKey
    });
    try {
        let said = "";
        const result = await execCommand(client, edgeLauncher(connection.username !== "root"), {
            input: script,
            onStdout: (chunk) => {
                said += chunk.toString("utf8");
            }
        });
        if (result.code === 3) throw new RouterRefusal("unsupported");
        if (result.code !== 0) throw new Error(`The machine answered exit ${result.code}`);
        return said;
    } finally {
        client.end();
    }
}

/** The address Polaris connects from, as the machine sees it. */
async function managementAddress(connection: HostConnection): Promise<string | null> {
    const client = await openSshClient({
        host: connection.address,
        port: connection.port,
        username: connection.username,
        auth: connection.auth,
        pinnedHostKey: connection.hostKey
    });
    try {
        let said = "";
        await execCommand(client, 'printf %s "${SSH_CLIENT%% *}"', {
            onStdout: (chunk) => {
                said += chunk.toString("utf8");
            }
        });
        return isIP(said.trim()) === 4 ? said.trim() : null;
    } finally {
        client.end();
    }
}

async function connectionFor(hostId: string, ownerId: string): Promise<HostConnection> {
    const connection = await getHostConnection(hostId, ownerId);
    if (!hasRoot(connection)) throw new RouterRefusal("noRoot");
    return connection;
}

async function probe(connection: HostConnection): Promise<RouterReading> {
    return readProbe(await runScript(connection, plans.PROBE_SCRIPT));
}

/** The machines that could be a router, for the picker. */
export async function routerMachines(ownerId: string): Promise<RouterMachine[]> {
    const hosts = await prisma.host.findMany({
        where: { ownerId },
        select: { id: true, name: true, address: true, username: true, sudo: true },
        orderBy: { name: "asc" },
        take: MACHINE_CHOICES
    });
    return hosts.map(({ id, name, address, username, sudo }) => ({
        id,
        name,
        address,
        root: sudo || username === "root"
    }));
}

/** One machine's plan and how it stands now. A machine that does not answer still
 *  has its plan on screen. */
export async function readRouter(hostId: string, ownerId: string): Promise<RouterView> {
    const connection = await connectionFor(hostId, ownerId);
    const [plan, reading] = await Promise.all([
        storedPlan(hostId),
        probe(connection).catch((error: unknown) => {
            console.error("polaris: a router could not be read:", error);
            return null;
        })
    ]);
    return { plan, reading };
}

/** Refuse what would fail or cut the machine off, before anything is sent. A port the
 *  running plan already holds may be unplugged right now: the router works without it
 *  and takes it back when it returns. */
export function refusalOf(
    plan: plans.RouterPlan,
    reading: RouterReading,
    connectedTo: string,
    saved: plans.RouterPlan | null = null
): RouterRefusalCode | null {
    const held = saved ? [...saved.wans, ...saved.lans].map((link) => link.interface) : [];
    const known = new Set([...reading.ports.map(({ name }) => name), ...held]);
    const used = [...plan.wans, ...plan.lans].map((link) => link.interface);
    if (used.some((name) => !known.has(name))) return "missingPort";
    const notRadio = plan.lans.some((lan) => {
        if (!lan.wifi) return false;
        const port = reading.ports.find(({ name }) => name === lan.interface);
        // Unplugged is not refused: a USB radio returns, as any other held port does.
        return port ? port.wireless !== true : false;
    });
    if (notRadio) return "notRadio";
    const lines = reading.ports.filter(({ name }) =>
        plan.wans.some((wan) => wan.interface === name)
    );
    const lineSubnets = lines.flatMap(({ addresses }) => addresses);
    const overlaps = plan.lans.some((lan) =>
        lineSubnets.some((subnet) => cidrsOverlap(lan.cidr, subnet))
    );
    if (overlaps) return "lineOverlap";
    const lockedOut = plan.lans.some((lan) => {
        if (lan.vlan !== null) return false;
        const port = reading.ports.find(({ name }) => name === lan.interface);
        const carries = port?.addresses.some((held) => held.split("/")[0] === connectedTo);
        return carries === true && lan.address !== connectedTo;
    });
    if (lockedOut) return "lockout";
    // A fixed line in place of the address Polaris comes in by leaves it talking to nobody.
    const movesLogin = plan.wans.some((wan) => {
        if (plans.modeOf(wan) !== "static" || wan.vlan !== null) return false;
        const port = reading.ports.find(({ name }) => name === wan.interface);
        const carries = port?.addresses.some((held) => held.split("/")[0] === connectedTo);
        return carries === true && wan.address?.split("/")[0] !== connectedTo;
    });
    return movesLogin ? "lockout" : null;
}

type ApplyEnding = "confirmed" | "rolledBack";

/** Run a script until the machine says how the change ended, or the time is up. */
async function endingOf(
    connection: HostConnection,
    script: string,
    deadline: number
): Promise<ApplyEnding | null> {
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, CONFIRM_POLL_MS));
        const answer = await runScript(connection, script).catch(() => "");
        if (answer.includes("confirmed")) return "confirmed";
        if (answer.includes("rolled-back")) return "rolledBack";
    }
    return null;
}

/** Wait for the change to hold. A machine still answering when the time is up is told
 *  to go back and waited for, so nobody is told it went back before it has: a retry
 *  meanwhile would land on the change that failed. Null when it never answered. */
async function applyEnding(
    connection: HostConnection,
    applyId: string
): Promise<ApplyEnding | null> {
    const sent = Date.now();
    return (
        (await endingOf(connection, plans.renderConfirm(applyId), sent + CONFIRM_MS)) ??
        (await endingOf(connection, plans.renderRollback(applyId), sent + SETTLE_MS))
    );
}

/** Make the machine run this plan, keeping the plan only once it really does. */
export async function applyRouter(hostId: string, ownerId: string, input: unknown): Promise<void> {
    const parsed = plans.routerPlanSchema.safeParse(input);
    if (!parsed.success) throw new RouterRefusal("invalid");
    const plan = parsed.data;
    await serialized(hostId, async () => {
        const connection = await connectionFor(hostId, ownerId);
        const reading = await probe(connection).catch(() => {
            throw new RouterRefusal("unreachable");
        });
        const saved = await storedPlan(hostId);
        const refusal = refusalOf(plan, reading, connection.address, saved);
        if (refusal) throw new RouterRefusal(refusal);
        const secrets = plans.secretsOf(plan, await storedSecrets(hostId));
        if (!secrets) throw new RouterRefusal("noPassword");
        const management = await managementAddress(connection).catch(() => null);
        const applyId = randomUUID();
        await runScript(
            connection,
            plans.renderApply(plan, { management, sshPort: connection.port }, applyId, secrets)
        );
        const ending = await applyEnding(connection, applyId);
        if (ending === null) throw new RouterRefusal("unconfirmed");
        if (ending === "rolledBack") throw new RouterRefusal("rolledBack");
        await keepSecrets(hostId, secrets);
        await setSetting(plans.routerPlanKey(hostId), JSON.stringify(plans.withoutSecrets(plan)));
    });
}

/** Make the machine an ordinary one again. */
export async function removeRouter(hostId: string, ownerId: string): Promise<void> {
    await serialized(hostId, async () => {
        const connection = await connectionFor(hostId, ownerId);
        await runScript(connection, plans.REMOVE_SCRIPT);
        await setSetting(plans.routerPlanKey(hostId), null);
        await setSetting(plans.routerSecretsKey(hostId), null);
    });
}
