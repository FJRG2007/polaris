/**
 * A month's statement for a scope: the whole instance, some organizations, or
 * one project.
 *
 * The scope is decided by whoever authorized the caller and handed in here -
 * never read from the request - so no month or format a reader asks for can
 * widen what a statement covers. The same rule the audit reader keeps.
 *
 * Projects are attributed to whoever owns them now - or, for a month that has
 * ended, whoever owned them when it was frozen. A project moved between
 * organizations mid-month is on its current owner's statement for the whole
 * month; a service deleted during the month took its history with it, so what
 * it used is on nobody's.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { getBillingRates } from "./rates";
import { machineCores } from "@/lib/machine-cores";
import { meterSubjects, type MeteredSubject } from "./usage";
import { LOCAL_HOST_SUBJECT, ROLLUP_RETENTION_MS } from "@/lib/metrics-shared";

export type BillingScope =
    | { readonly kind: "all" }
    | { readonly kind: "orgs"; readonly orgIds: readonly string[] }
    | { readonly kind: "project"; readonly projectId: string };

/** A statement, and what the screen needs to say about how complete it is. */
export interface StatementView {
    readonly statement: core.Statement;
    readonly monthLabel: string;
    /** Every month a statement can be read for, newest first. */
    readonly months: readonly string[];
    /** Whether the month is still running, so the figures are so far rather than
     *  final. */
    readonly current: boolean;
    /** ISO: the moment the figures run up to. */
    readonly through: string;
    /** ISO: when the month began before the oldest figure kept, the oldest one -
     *  so the screen can say the start of the month is missing. Null otherwise. */
    readonly keptFrom: string | null;
    readonly generatedAt: string;
}

/** Raised with a sentence the screen can show as it is. */
export class BillingRequestError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "BillingRequestError";
    }
}

/** The months a statement can be read for, as of now. */
export function offeredMonths(now: Date = new Date()): string[] {
    return core.billingMonthsOffered(now, ROLLUP_RETENTION_MS);
}

/**
 * The month asked for, or this one when none was. A month nothing is kept for -
 * one still to come, or one older than the figures - is refused rather than
 * answered with a statement of zeros.
 */
export function resolveMonth(requested: string | undefined, now: Date = new Date()): string {
    const months = offeredMonths(now);
    const month = requested ?? core.billingMonthOf(now);
    if (!months.includes(month))
        throw new BillingRequestError("No figures are kept for that month");
    return month;
}

function projectWhere(scope: BillingScope) {
    if (scope.kind === "orgs") return { orgId: { in: [...scope.orgIds] } };
    if (scope.kind === "project") return { id: scope.projectId };
    return {};
}

/** What a project is called on a statement, and who answers for it. */
function ownerOf(project: {
    ownerId: string;
    orgId: string | null;
    org: { name: string; slug: string } | null;
    owner: { name: string | null; username: string | null };
}): core.BillingOwner {
    if (project.orgId && project.org) {
        return { kind: "org", id: project.orgId, name: project.org.name, handle: project.org.slug };
    }
    const { name, username } = project.owner;
    return {
        kind: "user",
        id: project.ownerId,
        name: name || (username ? `@${username}` : "A former member"),
        handle: username || null
    };
}

/** The running month's statement, so far. */
export async function readMonthToDate(
    scope: BillingScope,
    now: Date = new Date()
): Promise<StatementView> {
    return readStatement(scope, core.billingMonthOf(now), now);
}

/** How long after a month ends its last readings may still be landing. Past it,
 *  the month is frozen the next time it is read. */
const SETTLE_MS = 3_600_000;

/** Whether a project on a frozen month's statement is in the scope asked for. */
function inScope(scope: BillingScope, project: core.MeteredProject): boolean {
    if (scope.kind === "orgs")
        return project.owner.kind === "org" && scope.orgIds.includes(project.owner.id);
    if (scope.kind === "project") return project.projectId === scope.projectId;
    return true;
}

/**
 * The statement for one scope and month.
 *
 * Every project in scope has a line, including one that used nothing: a
 * statement that leaves a project off reads as a project somebody forgot, and
 * "nothing" is an answer the person paying wants to see.
 *
 * A month that has ended is frozen the first time it is read after it settles:
 * the whole instance's projects and prices are kept as they were then, and every
 * read after that is built from them, so an exported month never changes.
 */
export async function readStatement(
    scope: BillingScope,
    month: string,
    now: Date = new Date()
): Promise<StatementView> {
    const range = core.billingMonthRange(month);
    if (!range) throw new BillingRequestError("Pick a month");

    const through = new Date(Math.min(range.to.getTime(), now.getTime()));
    const frozen =
        now.getTime() >= range.to.getTime() + SETTLE_MS
            ? await frozenMonth(month, range, now)
            : null;
    const [projects, rates] = frozen
        ? [frozen.projects.filter((project) => inScope(scope, project)), frozen.rates]
        : await Promise.all([meterProjects(scope, range.from, through), getBillingRates()]);
    const keptFrom = frozen ? frozen.keptFrom : keptFromAt(range.from, now);

    return {
        statement: core.buildStatement(month, projects, rates),
        monthLabel: core.billingMonthLabel(month),
        months: offeredMonths(now),
        current: now < range.to,
        through: through.toISOString(),
        keptFrom: keptFrom?.toISOString() ?? null,
        generatedAt: (frozen?.createdAt ?? now).toISOString()
    };
}

/** The oldest figure kept as of `at`, when the month began before it. */
function keptFromAt(from: Date, at: Date): Date | null {
    const oldestKept = at.getTime() - ROLLUP_RETENTION_MS;
    return from.getTime() < oldestKept ? new Date(oldestKept) : null;
}

/**
 * A closed month as it was frozen, freezing it now if nobody has read it since
 * it settled. Two first reads at once both work it out, and both answer with
 * whichever was kept.
 */
async function frozenMonth(
    month: string,
    range: { from: Date; to: Date },
    now: Date
): Promise<{
    projects: core.MeteredProject[];
    rates: core.BillingRates | null;
    keptFrom: Date | null;
    createdAt: Date;
}> {
    let held = await prisma.statementSnapshot.findUnique({ where: { month } });
    if (!held) {
        const [projects, rates] = await Promise.all([
            meterProjects({ kind: "all" }, range.from, range.to),
            getBillingRates()
        ]);
        await prisma.statementSnapshot.createMany({
            data: [
                {
                    month,
                    rates: rates ? JSON.stringify(rates) : null,
                    projects: JSON.stringify(projects),
                    keptFrom: keptFromAt(range.from, now)
                }
            ],
            skipDuplicates: true
        });
        held = await prisma.statementSnapshot.findUnique({ where: { month } });
        if (!held) throw new Error(`the statement for ${month} was not kept`);
    }
    const projects: unknown = JSON.parse(held.projects);
    return {
        projects: Array.isArray(projects) ? (projects as core.MeteredProject[]) : [],
        rates: core.storedBillingRates(held.rates),
        keptFrom: held.keptFrom,
        createdAt: held.createdAt
    };
}

/** Every project in scope, with what its services and volumes used in [from, to). */
async function meterProjects(
    scope: BillingScope,
    from: Date,
    to: Date
): Promise<core.MeteredProject[]> {
    const [projects, cores] = await Promise.all([
        prisma.project.findMany({
            where: projectWhere(scope),
            select: {
                id: true,
                name: true,
                ownerId: true,
                orgId: true,
                org: { select: { name: true, slug: true } },
                owner: { select: { name: true, username: true } },
                environments: {
                    select: {
                        applications: {
                            select: {
                                id: true,
                                target: { select: { kind: true, hostId: true } },
                                volumes: { select: { id: true } }
                            }
                        }
                    }
                }
            }
        }),
        machineCores()
    ]);

    // Each subject, and the project it is billed to.
    const subjects: MeteredSubject[] = [];
    const projectOf = new Map<string, string>();
    for (const project of projects) {
        for (const environment of project.environments) {
            for (const app of environment.applications) {
                // The machine a service runs on, under the id its load is kept
                // as: the box Polaris is on has a reserved one.
                const machine =
                    app.target.kind === "local" || !app.target.hostId
                        ? LOCAL_HOST_SUBJECT
                        : app.target.hostId;
                subjects.push({
                    subjectType: "app",
                    subjectId: app.id,
                    cores: cores.get(machine) ?? null
                });
                projectOf.set(`app:${app.id}`, project.id);
                for (const volume of app.volumes) {
                    subjects.push({ subjectType: "volume", subjectId: volume.id, cores: null });
                    projectOf.set(`volume:${volume.id}`, project.id);
                }
            }
        }
    }

    const used = await meterSubjects(subjects, from, to);
    const byProject = new Map<string, core.BillingUsage>();
    for (const [subject, usage] of used) {
        const projectId = projectOf.get(subject);
        if (!projectId) continue;
        byProject.set(
            projectId,
            core.addUsage(byProject.get(projectId) ?? core.EMPTY_USAGE, usage)
        );
    }

    return projects.map((project) => ({
        projectId: project.id,
        projectName: project.name,
        owner: ownerOf(project),
        usage: byProject.get(project.id) ?? core.EMPTY_USAGE
    }));
}
