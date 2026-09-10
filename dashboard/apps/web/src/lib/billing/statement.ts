/**
 * A month's statement for a scope: the whole instance, some organizations, or
 * one project.
 *
 * The scope is decided by whoever authorized the caller and handed in here -
 * never read from the request - so no month or format a reader asks for can
 * widen what a statement covers. The same rule the audit reader keeps.
 *
 * Projects are attributed to whoever owns them now. A project moved between
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
    if (!months.includes(month)) throw new BillingRequestError("No figures are kept for that month");
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
export async function readMonthToDate(scope: BillingScope, now: Date = new Date()): Promise<StatementView> {
    return readStatement(scope, core.billingMonthOf(now), now);
}

/**
 * The statement for one scope and month.
 *
 * Every project in scope has a line, including one that used nothing: a
 * statement that leaves a project off reads as a project somebody forgot, and
 * "nothing" is an answer the person paying wants to see.
 */
export async function readStatement(
    scope: BillingScope,
    month: string,
    now: Date = new Date()
): Promise<StatementView> {
    const range = core.billingMonthRange(month);
    if (!range) throw new BillingRequestError("Pick a month");
    const through = new Date(Math.min(range.to.getTime(), now.getTime()));

    const [projects, cores, rates] = await Promise.all([
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
        machineCores(),
        getBillingRates()
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
                    app.target.kind === "local" || !app.target.hostId ? LOCAL_HOST_SUBJECT : app.target.hostId;
                subjects.push({ subjectType: "app", subjectId: app.id, cores: cores.get(machine) ?? null });
                projectOf.set(`app:${app.id}`, project.id);
                for (const volume of app.volumes) {
                    subjects.push({ subjectType: "volume", subjectId: volume.id, cores: null });
                    projectOf.set(`volume:${volume.id}`, project.id);
                }
            }
        }
    }

    const used = await meterSubjects(subjects, range.from, through);
    const byProject = new Map<string, core.BillingUsage>();
    for (const [subject, usage] of used) {
        const projectId = projectOf.get(subject);
        if (!projectId) continue;
        byProject.set(projectId, core.addUsage(byProject.get(projectId) ?? core.EMPTY_USAGE, usage));
    }

    const statement = core.buildStatement(
        month,
        projects.map((project) => ({
            projectId: project.id,
            projectName: project.name,
            owner: ownerOf(project),
            usage: byProject.get(project.id) ?? core.EMPTY_USAGE
        })),
        rates
    );

    const oldestKept = now.getTime() - ROLLUP_RETENTION_MS;
    return {
        statement,
        monthLabel: core.billingMonthLabel(month),
        months: offeredMonths(now),
        current: now < range.to,
        through: through.toISOString(),
        keptFrom: range.from.getTime() < oldestKept ? new Date(oldestKept).toISOString() : null,
        generatedAt: now.toISOString()
    };
}
