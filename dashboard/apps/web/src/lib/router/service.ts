/**
 * Turning an enrolled machine into this network's router, and reading it back.
 *
 * Everything reaches the machine over the SSH login Polaris already holds, which
 * needs root, so there is nothing to install by hand. Applying a plan can cut the
 * very connection it travels on, so it is never trusted to have worked: Polaris has
 * to come back and confirm, and a machine that hears nothing undoes the change
 * (`renderApply`).
 */

import * as plans from "./plan";
import { isIP } from "node:net";
import { prisma } from "@polaris/db";
import { readProbe, type RouterReading } from "./read";
import { edgeLauncher } from "@/lib/deploy/server-edge";
import { execCommand, openSshClient } from "@polaris/ssh";
import { cidrsOverlap } from "@/lib/vpn/networks";
import { getSetting, setSetting } from "@/lib/setting-store";
import { getHostConnection, type HostConnection } from "@/lib/host-service";

/** The most machines offered: the picker searches within these. */
const MACHINE_CHOICES = 1000;
/** How long Polaris keeps trying to come back, inside the machine's own timer. */
const CONFIRM_MS = 100_000;
const CONFIRM_POLL_MS = 3_000;

export type RouterRefusalCode =
    | "noRoot"
    | "unreachable"
    | "unsupported"
    | "missingPort"
    | "lineOverlap"
    | "lockout"
    | "rolledBack"
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

function planKey(hostId: string): string {
    return `router.plan.${hostId}`;
}

async function storedPlan(hostId: string): Promise<plans.RouterPlan | null> {
    const raw = await getSetting(planKey(hostId));
    if (!raw) return null;
    try {
        return plans.readPlan(JSON.parse(raw));
    } catch {
        return null;
    }
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

/** Refuse what would fail or cut the machine off, before anything is sent. */
export function refusalOf(
    plan: plans.RouterPlan,
    reading: RouterReading,
    connectedTo: string
): RouterRefusalCode | null {
    const known = new Set(reading.ports.map(({ name }) => name));
    const used = [...plan.wans, ...plan.lans].map((link) => link.interface);
    if (used.some((name) => !known.has(name))) return "missingPort";
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
    return lockedOut ? "lockout" : null;
}

/** Wait for the machine to say the change holds, keeping it when it does. */
async function confirmed(connection: HostConnection): Promise<boolean> {
    const deadline = Date.now() + CONFIRM_MS;
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, CONFIRM_POLL_MS));
        const answer = await runScript(connection, plans.CONFIRM_SCRIPT).catch(() => "");
        if (answer.includes("confirmed")) return true;
        if (answer.includes("rolled-back")) return false;
    }
    return false;
}

/** Make the machine run this plan, keeping the plan only once it really does. */
export async function applyRouter(
    hostId: string,
    ownerId: string,
    input: unknown
): Promise<RouterReading> {
    const parsed = plans.routerPlanSchema.safeParse(input);
    if (!parsed.success) throw new RouterRefusal("invalid");
    const plan = parsed.data;
    return serialized(hostId, async () => {
        const connection = await connectionFor(hostId, ownerId);
        const reading = await probe(connection).catch(() => {
            throw new RouterRefusal("unreachable");
        });
        const refusal = refusalOf(plan, reading, connection.address);
        if (refusal) throw new RouterRefusal(refusal);
        const management = await managementAddress(connection).catch(() => null);
        await runScript(
            connection,
            plans.renderApply(plan, { management, sshPort: connection.port })
        );
        if (!(await confirmed(connection))) throw new RouterRefusal("rolledBack");
        await setSetting(planKey(hostId), JSON.stringify(plan));
        return probe(connection);
    });
}

/** Make the machine an ordinary one again. */
export async function removeRouter(hostId: string, ownerId: string): Promise<void> {
    await serialized(hostId, async () => {
        const connection = await connectionFor(hostId, ownerId);
        await runScript(connection, plans.REMOVE_SCRIPT);
        await setSetting(planKey(hostId), null);
    });
}
