"use server";

/**
 * Reading and working through what broke.
 *
 * The screen renders its shell immediately and asks for the numbers, which is
 * why the read is an action rather than page data: the window and the filter
 * change constantly, and holding the whole page back for a database read every
 * time somebody clicks a tab is a blank page every time somebody clicks a tab.
 *
 * Access is the same pair Analytics and the firewall use - `deploy.manage` to
 * open the app at all, and ownership of the project for everything inside it -
 * plus every instance administrator, which is how Polaris' own project is
 * reachable by whoever runs the box rather than only by whoever installed it.
 */

import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import { slugify } from "@polaris/deploy";
import { appBaseUrl } from "@/lib/domain-service";
import { requirePermission } from "@/lib/session";
import { scopeOrgIdFor } from "@/lib/workspace-scope";
import * as report from "@/lib/telemetry/report-service";
import * as projects from "@/lib/telemetry/project-service";

const PATH = "/apps/telemetry";

async function actor(): Promise<projects.TelemetryActor> {
    const user = await requirePermission("deploy.manage");
    return { id: user.id, isAdmin: user.isAdmin };
}

function failure(caught: unknown, fallback: string): { error: string } {
    if (caught instanceof projects.TelemetryAccessError) return { error: caught.message };
    console.error("polaris: a telemetry action failed:", caught);
    return { error: fallback };
}

export interface TelemetryOverview {
    readonly projects: readonly (projects.ProjectSummary & { dsn: string })[];
    readonly issues: readonly report.IssueRow[];
    readonly counts: Readonly<Record<string, number>>;
    readonly windowDays: number;
}

/**
 * Everything the list needs, in one call.
 *
 * The projects come with their DSN already built, because the address is the
 * only thing anybody has to copy out of this app and making the screen ask for
 * it separately would be a second round trip for a string.
 */
export async function telemetryOverviewAction(input: {
    projectId?: string | null;
    status?: string;
    query?: string;
}): Promise<{ data?: TelemetryOverview; error?: string }> {
    const caller = await actor();
    try {
        const orgId = await scopeOrgIdFor(caller.id);
        const [rows, origin] = await Promise.all([
            projects.listProjects(caller, orgId),
            appBaseUrl()
        ]);
        const withDsn = rows.map((row) => ({ ...row, dsn: projects.dsnFor(row, origin) }));

        const chosen = withDsn.find((row) => row.id === input.projectId) ?? withDsn[0];
        if (!chosen) {
            return { data: { projects: withDsn, issues: [], counts: {}, windowDays: report.TELEMETRY_WINDOW_DAYS } };
        }
        await projects.requireProject(caller, chosen.id);

        const [issues, counts] = await Promise.all([
            report.listIssues(chosen.id, { status: input.status ?? "unresolved", query: input.query }),
            report.issueCounts(chosen.id)
        ]);
        return {
            data: { projects: withDsn, issues, counts, windowDays: report.TELEMETRY_WINDOW_DAYS }
        };
    } catch (caught) {
        return failure(caught, "Those projects could not be read");
    }
}

export async function openIssueAction(
    projectId: string,
    issueId: string
): Promise<{ issue?: report.IssueDetail; error?: string }> {
    const caller = await actor();
    try {
        await projects.requireProject(caller, projectId);
        const issue = await report.getIssue(projectId, issueId);
        if (!issue) return { error: "That issue no longer exists" };
        return { issue };
    } catch (caught) {
        return failure(caught, "That issue could not be read");
    }
}

export async function setIssueStatusAction(
    projectId: string,
    issueId: string,
    status: string
): Promise<{ error?: string }> {
    const caller = await actor();
    if (!(core.TELEMETRY_STATUSES as readonly string[]).includes(status)) {
        return { error: "That is not something an issue can be" };
    }
    try {
        await projects.requireProject(caller, projectId);
        await report.setIssueStatus(projectId, issueId, status as core.TelemetryStatus, caller.id);
        revalidatePath(PATH);
        return {};
    } catch (caught) {
        return failure(caught, "That issue could not be changed");
    }
}

export async function deleteIssueAction(projectId: string, issueId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await projects.requireProject(caller, projectId);
        await report.deleteIssue(projectId, issueId);
        revalidatePath(PATH);
        return {};
    } catch (caught) {
        return failure(caught, "That issue could not be deleted");
    }
}

export async function createTelemetryProjectAction(name: unknown): Promise<{ id?: string; error?: string }> {
    const caller = await actor();
    const said = String(name ?? "").trim();
    if (!said || said.length > 80) return { error: "Give it a name" };
    try {
        const orgId = await scopeOrgIdFor(caller.id);
        const made = await projects.createProject({
            ownerId: caller.id,
            orgId,
            name: said,
            slug: slugify(said) || "project"
        });
        revalidatePath(PATH);
        return { id: made.id };
    } catch (caught) {
        return failure(caught, "That project could not be made");
    }
}

export async function updateTelemetryProjectAction(
    projectId: string,
    input: { name?: string; enabled?: boolean; retentionDays?: number }
): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await projects.requireProject(caller, projectId);
        const days = input.retentionDays;
        if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 365)) {
            return { error: "Keep events for between 1 and 365 days" };
        }
        await projects.updateProject(projectId, input);
        revalidatePath(PATH);
        return {};
    } catch (caught) {
        return failure(caught, "That project could not be changed");
    }
}

/** A new key, and a new DSN with it. The old one stops working immediately,
 *  which is the point of asking for it. */
export async function rotateTelemetryKeyAction(
    projectId: string
): Promise<{ dsn?: string; error?: string }> {
    const caller = await actor();
    try {
        const project = await projects.requireProject(caller, projectId);
        const publicKey = await projects.rotateKey(projectId);
        revalidatePath(PATH);
        return { dsn: projects.dsnFor({ number: project.number, publicKey }, await appBaseUrl()) };
    } catch (caught) {
        return failure(caught, "That key could not be replaced");
    }
}

export async function deleteTelemetryProjectAction(projectId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await projects.requireProject(caller, projectId);
        if (!(await projects.deleteProject(projectId))) {
            return { error: "Polaris' own project cannot be deleted" };
        }
        revalidatePath(PATH);
        return {};
    } catch (caught) {
        return failure(caught, "That project could not be deleted");
    }
}

/**
 * Who may report into a project.
 *
 * The one screen in this app that changes what the ingest will accept, so the
 * input is checked against a schema rather than trusted: a rule that is not an
 * address, or "only these addresses" with none named, would be a project that
 * silently turns away everything.
 */
export async function setReporterRulesAction(
    projectId: string,
    input: unknown
): Promise<{ error?: string; }> {
    const caller = await actor();
    const parsed = core.reporterRulesSchema.safeParse(input);
    if (!parsed.success) {
        return { error: parsed.error.issues[0]?.message ?? "Those rules could not be read" };
    }
    try {
        await projects.requireProject(caller, projectId);
        await projects.setReporterRules(projectId, parsed.data);
        revalidatePath(PATH);
        return {};
    } catch (caught) {
        return failure(caught, "Those rules could not be saved");
    }
}

/**
 * A key of the project's own, shown once.
 *
 * The address in a DSN is public by design; this is not, and there is nowhere to
 * read it back from - what is stored is a digest. Somebody who loses it mints
 * another, which is the same thing as rotating it.
 */
export async function mintTelemetrySecretAction(
    projectId: string
): Promise<{ secret?: string; error?: string; }> {
    const caller = await actor();
    try {
        await projects.requireProject(caller, projectId);
        const secret = await projects.mintSecret(projectId);
        revalidatePath(PATH);
        return { secret };
    } catch (caught) {
        return failure(caught, "That key could not be made");
    }
}

/** Stop asking for a key, and forget the one there was. */
export async function clearTelemetrySecretAction(projectId: string): Promise<{ error?: string; }> {
    const caller = await actor();
    try {
        await projects.requireProject(caller, projectId);
        await projects.clearSecret(projectId);
        revalidatePath(PATH);
        return {};
    } catch (caught) {
        return failure(caught, "That key could not be removed");
    }
}

/** Forget what was turned away, once somebody has read it and acted on it. */
export async function clearTelemetryRefusalsAction(projectId: string): Promise<{ error?: string; }> {
    const caller = await actor();
    try {
        await projects.requireProject(caller, projectId);
        await projects.clearRefusals(projectId);
        revalidatePath(PATH);
        return {};
    } catch (caught) {
        return failure(caught, "That could not be cleared");
    }
}
