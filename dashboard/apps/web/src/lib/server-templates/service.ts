/**
 * Server templates: keeping them, assigning them to servers, checking each
 * server against its templates over SSH and putting drift back.
 *
 * A check is one SSH command running a fixed script (see `./model`), with the
 * template's items as its arguments. It runs as root when the login is root or
 * was granted password-less sudo at enrollment, and as the login otherwise -
 * most of what a template asks about is readable by anyone, and what is not is
 * reported as unreadable rather than as drift. A fix always needs root, and is
 * refused up front on a server that never granted it.
 *
 * Server-only.
 */

import { prisma, Prisma } from "@polaris/db";
import { execCommand, openSshClient } from "@polaris/ssh";
import { getHostConnection, HostCredentialsError, type HostConnection } from "@/lib/host-service";
import {
    hostTemplateInputSchema,
    templateSpecSchema,
    type DriftItem,
    type HostTemplateInput,
    type TemplateSpec,
    type TemplateStatus
} from "@polaris/core";
import { CHECK_SCRIPT, FIX_SCRIPT, computeDrift, fixWords, parseReport, planItems, scriptCommand } from "./model";

/** A refusal the screen words, by code. */
export class TemplateRefusal extends Error {
    constructor(readonly code: "notFound" | "nameTaken" | "noRoot" | "unreachable" | "failed" | "nothingToFix" | "local" | "credentials") {
        super(code);
    }
}

export interface TemplateView {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly spec: TemplateSpec;
    readonly servers: number;
}

export interface AssignmentView {
    readonly id: string;
    readonly templateId: string;
    readonly templateName: string;
    readonly autoFix: boolean;
    readonly status: TemplateStatus;
    readonly drift: DriftItem[];
    readonly error: string | null;
    readonly checkedAt: string | null;
    readonly fixedAt: string | null;
}

const CHECK_TIMEOUT_MS = 2 * 60_000;
const FIX_TIMEOUT_MS = 15 * 60_000;
const MAX_OUTPUT = 256 * 1024;

/** A stored spec is read through the schema, so a row written by an older
 *  build still opens with every list present. */
function specOf(value: unknown): TemplateSpec {
    const parsed = templateSpecSchema.safeParse(value ?? {});
    return parsed.success ? parsed.data : templateSpecSchema.parse({});
}

function driftOf(value: unknown): DriftItem[] {
    return Array.isArray(value) ? (value as DriftItem[]) : [];
}

export async function listTemplates(ownerId: string): Promise<TemplateView[]> {
    const rows = await prisma.hostTemplate.findMany({
        where: { ownerId },
        select: { id: true, name: true, description: true, spec: true, _count: { select: { assignments: true } } },
        orderBy: { name: "asc" },
        take: 200
    });
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        spec: specOf(row.spec),
        servers: row._count.assignments
    }));
}

/** Create a template, or replace one of this owner's. */
export async function saveTemplate(ownerId: string, id: string | null, raw: HostTemplateInput): Promise<string> {
    const input = hostTemplateInputSchema.parse(raw);
    const data = { name: input.name, description: input.description, spec: input.spec as Prisma.InputJsonValue };
    try {
        if (id) {
            const updated = await prisma.hostTemplate.updateMany({ where: { id, ownerId }, data });
            if (updated.count === 0) throw new TemplateRefusal("notFound");
            // What the last check found was measured against the old items.
            await prisma.hostTemplateAssignment.updateMany({
                where: { templateId: id },
                data: { status: "unknown", drift: Prisma.DbNull, error: null, checkedAt: null }
            });
            return id;
        }
        const created = await prisma.hostTemplate.create({ data: { ...data, ownerId }, select: { id: true } });
        return created.id;
    } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
            throw new TemplateRefusal("nameTaken");
        }
        throw error;
    }
}

export async function deleteTemplate(ownerId: string, id: string): Promise<void> {
    const removed = await prisma.hostTemplate.deleteMany({ where: { id, ownerId } });
    if (removed.count === 0) throw new TemplateRefusal("notFound");
}

const ASSIGNMENT_SELECT = {
    id: true,
    templateId: true,
    autoFix: true,
    status: true,
    drift: true,
    error: true,
    checkedAt: true,
    fixedAt: true,
    template: { select: { name: true } }
} as const;

type AssignmentRow = Prisma.HostTemplateAssignmentGetPayload<{ select: typeof ASSIGNMENT_SELECT }>;

function viewOf(row: AssignmentRow): AssignmentView {
    return {
        id: row.id,
        templateId: row.templateId,
        templateName: row.template.name,
        autoFix: row.autoFix,
        status: row.status as TemplateStatus,
        drift: driftOf(row.drift),
        error: row.error,
        checkedAt: row.checkedAt?.toISOString() ?? null,
        fixedAt: row.fixedAt?.toISOString() ?? null
    };
}

/** The templates assigned to one of this owner's servers. */
export async function hostAssignments(ownerId: string, hostId: string): Promise<AssignmentView[]> {
    const rows = await prisma.hostTemplateAssignment.findMany({
        where: { hostId, host: { ownerId } },
        select: ASSIGNMENT_SELECT,
        orderBy: { createdAt: "asc" },
        take: 100
    });
    return rows.map(viewOf);
}

export async function assignTemplate(ownerId: string, templateId: string, hostId: string, autoFix: boolean): Promise<string> {
    const [template, host] = await Promise.all([
        prisma.hostTemplate.findFirst({ where: { id: templateId, ownerId }, select: { id: true } }),
        prisma.host.findFirst({ where: { id: hostId, ownerId }, select: { id: true } })
    ]);
    if (!template || !host) throw new TemplateRefusal("notFound");
    const row = await prisma.hostTemplateAssignment.upsert({
        where: { templateId_hostId: { templateId, hostId } },
        create: { templateId, hostId, autoFix },
        update: { autoFix },
        select: { id: true }
    });
    return row.id;
}

async function ownedAssignment(ownerId: string, id: string) {
    const row = await prisma.hostTemplateAssignment.findFirst({
        where: { id, host: { ownerId }, template: { ownerId } },
        select: { id: true, hostId: true, autoFix: true, drift: true, template: { select: { ownerId: true, spec: true } } }
    });
    if (!row) throw new TemplateRefusal("notFound");
    return row;
}

export async function unassignTemplate(ownerId: string, id: string): Promise<void> {
    await ownedAssignment(ownerId, id);
    await prisma.hostTemplateAssignment.delete({ where: { id } });
}

export async function setAutoFix(ownerId: string, id: string, autoFix: boolean): Promise<void> {
    await ownedAssignment(ownerId, id);
    await prisma.hostTemplateAssignment.update({ where: { id }, data: { autoFix } });
}

/** Whether the login reaches root, and how. */
function rootOf(connection: HostConnection): { root: boolean; sudo: boolean } {
    if (connection.username === "root") return { root: true, sudo: false };
    return { root: connection.sudo, sudo: connection.sudo };
}

async function runScript(
    connection: HostConnection,
    command: string,
    input: string | undefined,
    timeoutMs: number
): Promise<{ code: number; output: string }> {
    let client: Awaited<ReturnType<typeof openSshClient>>;
    try {
        client = await openSshClient({
            host: connection.address,
            port: connection.port,
            username: connection.username,
            auth: connection.auth,
            pinnedHostKey: connection.hostKey
        });
    } catch {
        throw new TemplateRefusal("unreachable");
    }
    const parts: Buffer[] = [];
    let size = 0;
    let timer: NodeJS.Timeout | undefined;
    try {
        const run = execCommand(client, command, {
            input,
            onStdout: (chunk) => {
                if (size >= MAX_OUTPUT) return;
                size += chunk.length;
                parts.push(chunk);
            }
        });
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new TemplateRefusal("failed")), timeoutMs);
        });
        const result = await Promise.race([run, timeout]);
        return { code: result.code, output: Buffer.concat(parts).toString("utf8") };
    } finally {
        if (timer) clearTimeout(timer);
        client.end();
    }
}

async function connectionFor(hostId: string, ownerId: string): Promise<HostConnection> {
    try {
        return await getHostConnection(hostId, ownerId);
    } catch (error) {
        if (error instanceof HostCredentialsError) throw new TemplateRefusal("credentials");
        throw new TemplateRefusal("notFound");
    }
}

async function record(id: string, data: Prisma.HostTemplateAssignmentUpdateInput): Promise<AssignmentView> {
    return viewOf(await prisma.hostTemplateAssignment.update({ where: { id }, data, select: ASSIGNMENT_SELECT }));
}

/** Read one server against one template and keep what was found. A server that
 *  cannot be reached keeps its last drift, marked failed with the reason. */
export async function checkAssignment(ownerId: string, id: string): Promise<AssignmentView> {
    const row = await ownedAssignment(ownerId, id);
    const spec = specOf(row.template.spec);
    const items = planItems(spec);
    if (items.length === 0) {
        return record(id, { status: "compliant", drift: [], error: null, checkedAt: new Date() });
    }
    try {
        const connection = await connectionFor(row.hostId, ownerId);
        const { sudo } = rootOf(connection);
        const command = scriptCommand(CHECK_SCRIPT, items.flatMap((item) => [...item.check]), sudo);
        const { output } = await runScript(connection, command, undefined, CHECK_TIMEOUT_MS);
        const report = parseReport(output);
        if (report.size === 0) throw new TemplateRefusal("failed");
        const drift = computeDrift(spec, report);
        return record(id, {
            status: drift.length === 0 ? "compliant" : "drifted",
            drift: drift as unknown as Prisma.InputJsonValue,
            error: null,
            checkedAt: new Date()
        });
    } catch (error) {
        const code = error instanceof TemplateRefusal ? error.code : "failed";
        if (!(error instanceof TemplateRefusal)) console.error("[server-templates] check failed", error);
        return record(id, { status: "failed", error: code, checkedAt: new Date() });
    }
}

/** Put back the drift the last check found - the items named, or every
 *  fixable one - then check again so the screen shows what is true now. */
export async function fixAssignment(ownerId: string, id: string, keys?: readonly string[]): Promise<AssignmentView> {
    const row = await ownedAssignment(ownerId, id);
    const spec = specOf(row.template.spec);
    const plan = fixWords(spec, driftOf(row.drift), keys);
    if (plan.keys.length === 0) throw new TemplateRefusal("nothingToFix");
    const connection = await connectionFor(row.hostId, ownerId);
    const { root, sudo } = rootOf(connection);
    if (!root) throw new TemplateRefusal("noRoot");

    const { output } = await runScript(connection, scriptCommand(FIX_SCRIPT, plan.words, sudo), plan.input, FIX_TIMEOUT_MS);
    const results = parseReport(output);
    await prisma.hostTemplateAssignment.update({ where: { id }, data: { fixedAt: new Date() } });
    const after = await checkAssignment(ownerId, id);
    const failed = plan.keys.some((_, index) => results.get(index + 1) !== "ok");
    if (failed && after.status !== "failed") return record(id, { error: "partial" });
    return after;
}

/** How long a check stays fresh before the scheduled pass reads it again. */
const CHECK_EVERY_MS = Number(process.env.POLARIS_TEMPLATE_CHECK_MS) || 6 * 60 * 60_000;
/** Servers read per pass, so one pass never holds many SSH sessions for long. */
const PER_PASS = 20;
/** No new server is started after this, so the slowest one still finishes
 *  before the scheduler would take the pass for stuck and start another. */
const PASS_BUDGET_MS = 5 * 60_000;

/** The scheduled pass: re-read the assignments checked longest ago, and put
 *  drift back where the assignment asks for that. */
export async function runTemplateSweep(): Promise<number> {
    const due = await prisma.hostTemplateAssignment.findMany({
        where: { OR: [{ checkedAt: null }, { checkedAt: { lt: new Date(Date.now() - CHECK_EVERY_MS) } }] },
        select: { id: true, autoFix: true, template: { select: { ownerId: true } } },
        orderBy: { checkedAt: { sort: "asc", nulls: "first" } },
        take: PER_PASS
    });
    const deadline = Date.now() + PASS_BUDGET_MS;
    let done = 0;
    for (const row of due) {
        if (Date.now() > deadline) break;
        done += 1;
        const ownerId = row.template.ownerId;
        try {
            const checked = await checkAssignment(ownerId, row.id);
            if (row.autoFix && checked.status === "drifted" && checked.drift.some((item) => item.fixable)) {
                await fixAssignment(ownerId, row.id).catch(async (error) => {
                    const code = error instanceof TemplateRefusal ? error.code : "failed";
                    await prisma.hostTemplateAssignment.update({ where: { id: row.id }, data: { error: code } });
                });
            }
        } catch (error) {
            console.error("[server-templates] sweep failed for an assignment", error);
        }
    }
    return done;
}
