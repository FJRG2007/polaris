/**
 * Environments made from other environments: a branch environment, and the one
 * a pull request gets.
 *
 * A clone is the environment's shape without its data. Every service comes over
 * with its source, build settings, variables, volumes, firewall rules and place
 * on the canvas; every managed database comes over as a new, empty one with
 * credentials of its own. Nothing is shared with the environment it came from -
 * not a volume, not a database - so a preview can be broken, migrated and thrown
 * away without production noticing.
 *
 * Secrets depend on who asked for the copy. One made by hand, by somebody
 * allowed into the environment it copies, takes them along, as ciphertext that
 * is never opened on the way. A pull request's preview does not: anybody who can
 * push a branch can open a pull request, the preview runs that branch's code,
 * and a secret copied into it is a secret handed to whoever wrote it. Its secret
 * variables are left behind, and the owner is told which ones - on the bell and
 * in each service's history - so one the preview needs is set on the preview.
 *
 * Every other variable is copied as it was written. One written as a reference
 * (`${{postgres.DATABASE_URL}}`) is resolved again in the clone and finds the
 * clone's database; one written as a literal address still points wherever it
 * pointed, which is the one way a clone can reach back into production.
 */

import { prisma } from "@polaris/db";
import { slugify } from "@polaris/deploy";
import { copyWafRule } from "../waf-service";
import { setSetting } from "../setting-store";
import { copyScopeValues } from "./env-values";
import * as activity from "../activity/activity";
import { parseGithubRepo } from "../repo-reference";
import { githubTokenForOwner } from "../github-access";
import { createNotification } from "../notification-service";
import { isGitBranchName, parseProjectFlags } from "@polaris/core";
import { listOpenPullRequests, pullRequestIsOpen, type OpenPullRequest } from "../github-service";

/** What makes an environment a preview. */
export interface PreviewOrigin {
    readonly pullRequest: number;
    /** "owner/repo" the pull request was opened on. */
    readonly repo: string;
    /** The head commit it is made for. */
    readonly sha?: string;
}

/**
 * A canvas layout with every node moved onto its copy: positions and links are
 * keyed by service and database ids, and a copy has ids of its own. A node that
 * was not copied is dropped, and so is every link to it.
 */
export function remapLayout(raw: string, ids: ReadonlyMap<string, string>): string {
    let layout: Record<string, unknown>;
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "{}";
        layout = parsed as Record<string, unknown>;
    } catch {
        return "{}";
    }
    const next: Record<string, unknown> = { ...layout };
    if (layout.pos && typeof layout.pos === "object") {
        next.pos = Object.fromEntries(
            Object.entries(layout.pos as Record<string, unknown>).flatMap(([id, point]) => {
                const moved = ids.get(id);
                return moved ? [[moved, point]] : [];
            })
        );
    }
    if (Array.isArray(layout.links)) {
        next.links = layout.links.flatMap((link: unknown) => {
            const entry = link && typeof link === "object" ? (link as Record<string, unknown>) : null;
            const source = typeof entry?.source === "string" ? ids.get(entry.source) : undefined;
            const target = typeof entry?.target === "string" ? ids.get(entry.target) : undefined;
            return entry && source && target ? [{ ...entry, source, target }] : [];
        });
    }
    return JSON.stringify(next);
}

/**
 * Copy an environment's services and databases into a new environment.
 *
 * `branch` makes every repository-built service in the clone build from and
 * follow that branch. Nothing is deployed here; the caller decides when. A copy
 * that fails partway is removed again, so trying once more is not refused by
 * the half of it that was made. Answers the secrets a preview was not given.
 */
export async function cloneEnvironment(
    sourceEnvironmentId: string,
    ownerId: string,
    input: {
        name: string;
        branch?: string | null;
        preview?: PreviewOrigin;
        /** The project the caller was authorized on. The copy lands in the
         *  source's project, so a source from any other project is refused -
         *  otherwise access checked on one project would create in another. */
        projectId?: string;
    }
): Promise<{ id: string; slug: string; withheld: string[] }> {
    const source = await prisma.environment.findFirst({
        where: {
            id: sourceEnvironmentId,
            project: { ownerId },
            ...(input.projectId ? { projectId: input.projectId } : {})
        },
        include: {
            project: { select: { id: true, slug: true } },
            applications: { include: { volumes: true } },
            databases: { orderBy: { createdAt: "asc" } }
        }
    });
    if (!source) throw new Error("Environment not found");
    const name = input.name.trim();
    const slug = slugify(name);
    if (!slug) throw new Error("Environment name must contain letters or digits");
    const clash = await prisma.environment.findFirst({
        where: { projectId: source.projectId, slug },
        select: { id: true }
    });
    if (clash) throw new Error("An environment with that name already exists");

    const branch = input.branch?.trim() || null;
    const secrets = !input.preview;
    const environment = await prisma.environment.create({
        data: {
            projectId: source.projectId,
            name,
            slug,
            isDefault: false,
            // Its own network when the original has one: a preview of an isolated
            // environment that could reach every other project would not be a copy.
            networkMode: source.networkMode,
            branch,
            pullRequest: input.preview?.pullRequest ?? null,
            previewRepo: input.preview?.repo ?? null,
            previewOfId: input.preview ? source.id : null,
            previewSha: input.preview?.sha ?? null
        }
    });

    try {
        const shared = await copyScopeValues(
            { scopeType: "environment", scopeId: source.id },
            { scopeType: "environment", scopeId: environment.id },
            { secrets }
        );
        await copyWafRule("environment", source.id, environment.id);

        // Every node's new id, for the canvas and for a hosted database's instance.
        const ids = new Map<string, string>();

        // Databases first, instances before the databases hosted inside them, so a
        // hosted one can be pointed at its clone's instance.
        const { createDatabase } = await import("@/lib/database-service");
        const ordered = [...source.databases].sort((a, b) => Number(Boolean(a.parentId)) - Number(Boolean(b.parentId)));
        for (const database of ordered) {
            const instanceId = database.parentId ? ids.get(database.parentId) : undefined;
            if (database.parentId && !instanceId) continue;
            const created = await createDatabase(ownerId, {
                environmentId: environment.id,
                targetId: database.targetId,
                name: database.name,
                engine: database.engine as Parameters<typeof createDatabase>[1]["engine"],
                version: database.version,
                privileges: database.privileges as Parameters<typeof createDatabase>[1]["privileges"],
                ...(instanceId ? { instanceId } : {})
            });
            ids.set(database.id, created.id);
        }

        // Cycle: the deploy service reaches this module.
        const { createApplication } = await import("@/lib/deploy-service");
        const { createVolume } = await import("@/lib/deploy-volume-service");
        const withheldByService: { applicationId: string; keys: string[] }[] = [];
        for (const application of source.applications) {
            const repositoryBuilt = application.sourceType === "dockerfile" || application.sourceType === "nixpacks";
            const created = await createApplication(ownerId, {
                environmentId: environment.id,
                targetId: application.targetId,
                name: application.name,
                sourceType: application.sourceType,
                sourceConfig: JSON.parse(application.sourceConfig) as Record<string, unknown>,
                // A clone given a branch follows it; that is what it is for. One
                // without a branch deploys the way its original does.
                autoDeploy: Boolean(branch) && repositoryBuilt ? true : application.autoDeploy,
                deployBranch: branch ? null : application.deployBranch,
                keepReleases: false,
                // As open or as closed as the one it copies: a clone of a service
                // reached only through the edge must not come up on the machine's
                // own address.
                publishPort: application.publishPort
            });
            ids.set(application.id, created.id);
            await prisma.application.update({
                where: { id: created.id },
                data: {
                    buildConfig: application.buildConfig,
                    healthcheck: application.healthcheck,
                    replicas: application.replicas,
                    cpuLimit: application.cpuLimit,
                    memoryLimitMb: application.memoryLimitMb,
                    commitFilter: application.commitFilter,
                    watchPaths: application.watchPaths,
                    // The edge settings and whether the port is open come over too:
                    // a copy that answered on a port its original keeps closed, or
                    // without the original's rate limits, is not a copy.
                    publishPort: application.publishPort,
                    edgeConfig: application.edgeConfig
                }
            });
            // And its firewall: every clone gets a public address, and a preview
            // of a service behind a login must not be the way around it.
            await copyWafRule("application", application.id, created.id);
            const own = await copyScopeValues(
                { scopeType: "application", scopeId: application.id },
                { scopeType: "application", scopeId: created.id },
                { secrets }
            );
            withheldByService.push({ applicationId: created.id, keys: own.withheld });
            for (const volume of application.volumes) {
                await createVolume(ownerId, {
                    applicationId: created.id,
                    name: volume.name,
                    mountPath: volume.mountPath,
                    kind: volume.kind as "volume" | "bind" | "nas",
                    // A named volume is namespaced by the clone's own project already.
                    // A path is not, so the clone gets one of its own beside the
                    // original's rather than writing into it.
                    ...(volume.kind === "volume"
                        ? {}
                        : {
                              source: `polaris/deploy/${source.project.slug}/${slug}/${application.slug}/${slugify(volume.name)}`
                          }),
                    ...(volume.connectionId ? { connectionId: volume.connectionId } : {}),
                    ...(volume.sizeLimit ? { sizeLimit: volume.sizeLimit } : {})
                });
            }
        }

        await prisma.environment.update({
            where: { id: environment.id },
            data: { layout: remapLayout(source.layout, ids) }
        });

        const withheld = [...new Set([...shared.withheld, ...withheldByService.flatMap((one) => one.keys)])];
        await activity.recordMany(
            withheldByService.flatMap((one) => {
                const keys = [...new Set([...shared.withheld, ...one.keys])];
                return keys.length > 0
                    ? [{ subjectType: "app" as const, subjectId: one.applicationId, action: "secrets-withheld", toValue: keys.join(", ") }]
                    : [];
            })
        );
        return { id: environment.id, slug: environment.slug, withheld };
    } catch (error) {
        await discardClone(environment.id, ownerId);
        throw error;
    }
}

/**
 * Remove a copy that failed partway, with the rows that name it but are not
 * tied to it: its variables and its firewall rules.
 */
async function discardClone(environmentId: string, ownerId: string): Promise<void> {
    try {
        const applications = await prisma.application.findMany({ where: { environmentId }, select: { id: true } });
        await prisma.envVar.deleteMany({ where: { scopeType: "environment", scopeId: environmentId } });
        await prisma.wafRule.deleteMany({
            where: {
                OR: [
                    { scopeType: "environment", scopeId: environmentId },
                    { scopeType: "application", scopeId: { in: applications.map((one) => one.id) } }
                ]
            }
        });
        const { deleteEnvironment } = await import("@/lib/deploy-service");
        await deleteEnvironment(environmentId, ownerId).catch(async (error: unknown) => {
            // Nothing in it was ever deployed, so the rows are all there is.
            console.error("polaris: a half-made environment copy could not be torn down:", error);
            await prisma.environment.deleteMany({ where: { id: environmentId } });
        });
    } catch (error) {
        console.error("polaris: a half-made environment copy could not be removed:", error);
    }
}

/**
 * Deploy everything in an environment: its databases first, so the services
 * that reference them resolve an address, then its services. Each one that
 * fails to start is named rather than stopping the rest.
 */
export async function deployEnvironment(
    environmentId: string,
    ownerId: string,
    userId: string,
    commit?: { sha: string; message?: string; authorName?: string | null; authorAvatarUrl?: string | null },
    trigger: "manual" | "preview" = "manual"
): Promise<{ started: number; failed: string[] }> {
    const [databases, applications] = await Promise.all([
        prisma.managedDatabase.findMany({
            where: { environmentId },
            orderBy: [{ parentId: "asc" }, { createdAt: "asc" }],
            select: { id: true, name: true, parentId: true }
        }),
        prisma.application.findMany({
            where: { environmentId },
            select: { id: true, name: true, sourceType: true }
        })
    ]);
    const { deployDatabase } = await import("@/lib/database-service");
    const deployService = await import("@/lib/deploy-service");
    const failed: string[] = [];
    let started = 0;
    // Instances before the databases inside them: a hosted database is created
    // by statements run in its instance's container.
    for (const database of [...databases].sort((a, b) => Number(Boolean(a.parentId)) - Number(Boolean(b.parentId)))) {
        try {
            await deployDatabase(database.id, ownerId, userId);
            started += 1;
        } catch (error) {
            failed.push(`${database.name}: ${error instanceof Error ? error.message : "could not start"}`);
        }
    }
    for (const application of applications) {
        try {
            await deployService.ensureApplicationDomain(application.id, ownerId).catch(() => undefined);
            const repositoryBuilt = application.sourceType === "dockerfile" || application.sourceType === "nixpacks";
            await deployService.deployApplication(
                application.id,
                ownerId,
                userId,
                repositoryBuilt && commit
                    ? {
                          commitSha: commit.sha,
                          commitMessage: commit.message,
                          authorName: commit.authorName ?? undefined,
                          authorAvatarUrl: commit.authorAvatarUrl ?? undefined,
                          trigger
                      }
                    : { trigger }
            );
            if (repositoryBuilt && commit) {
                // The poller would otherwise see a new head and deploy it again.
                await prisma.application.update({ where: { id: application.id }, data: { lastDeployedSha: commit.sha } });
            }
            started += 1;
        } catch (error) {
            failed.push(`${application.name}: ${error instanceof Error ? error.message : "could not start"}`);
        }
    }
    return { started, failed };
}

/** "owner/repo" of a service's GitHub repository, lower-cased, or null. */
function repositoryOf(sourceConfig: string): string | null {
    try {
        const source = JSON.parse(sourceConfig) as Record<string, unknown>;
        const parsed = typeof source.repoUrl === "string" ? parseGithubRepo(source.repoUrl) : null;
        return parsed ? `${parsed.owner}/${parsed.repo}`.toLowerCase() : null;
    } catch {
        return null;
    }
}

/**
 * The projects that want a preview for a pull request on `repo`: preview
 * environments switched on, and a service in the default environment built
 * from that repository.
 */
async function projectsPreviewing(repo: string) {
    const projects = await prisma.project.findMany({
        where: { environments: { some: { isDefault: true } } },
        select: {
            id: true,
            ownerId: true,
            flags: true,
            environments: {
                where: { isDefault: true },
                select: { id: true, applications: { select: { sourceConfig: true } } }
            }
        }
    });
    const wanted = repo.toLowerCase();
    return projects.flatMap((project) => {
        if (!parseProjectFlags(project.flags).previewEnvironments) return [];
        const base = project.environments[0];
        if (!base) return [];
        const builds = base.applications.some((one) => repositoryOf(one.sourceConfig) === wanted);
        return builds ? [{ projectId: project.id, ownerId: project.ownerId, baseEnvironmentId: base.id }] : [];
    });
}

/** Why a pull request from a fork gets no preview, said wherever it is skipped. */
export const FORK_REFUSAL =
    "Pull requests from forks are not previewed: their code would run with this project's variables and secrets.";

/** A preview's name. The repository is in it: one project can build from several,
 *  and each has its own pull request 12. */
export function previewName(repo: string, number: number): string {
    return `PR ${number} ${repo.toLowerCase()}`;
}

/** The keys named in a sentence short enough for a notification. */
function keyList(keys: readonly string[]): string {
    const shown = keys.slice(0, 8).join(", ");
    return keys.length > 8 ? `${shown} and ${keys.length - 8} more` : shown;
}

/**
 * Make sure a pull request has its preview, in every project that wants one -
 * or in `onlyProjectId` alone.
 *
 * Idempotent: an environment already there is left alone, because keeping it
 * current is ordinary auto-deploy - its services follow the pull request's
 * branch, so a push to it deploys them like any other push. Answers how many
 * previews were created.
 */
export async function ensurePullRequestPreview(
    pull: {
        repo: string;
        number: number;
        title: string;
        headBranch: string;
        headSha: string;
        /** Null when GitHub no longer knows where the head branch lives. */
        headRepo: string | null;
        authorName?: string | null;
        authorAvatarUrl?: string | null;
    },
    onlyProjectId?: string
): Promise<number> {
    // A head repository nobody can name is not known to be this one, so it is
    // refused like a fork.
    if (!pull.headRepo || pull.headRepo.toLowerCase() !== pull.repo.toLowerCase()) {
        console.info(`polaris: ${pull.repo}#${pull.number}: ${FORK_REFUSAL}`);
        return 0;
    }
    // The branch reaches `git clone --branch`; a name git would refuse is not
    // passed on to it.
    if (!isGitBranchName(pull.headBranch)) return 0;
    const repo = pull.repo.toLowerCase();
    let created = 0;
    for (const project of await projectsPreviewing(repo)) {
        if (onlyProjectId && project.projectId !== onlyProjectId) continue;
        const existing = await prisma.environment.findFirst({
            where: { projectId: project.projectId, pullRequest: pull.number, previewRepo: repo },
            select: { id: true }
        });
        if (existing) continue;
        try {
            const environment = await cloneEnvironment(project.baseEnvironmentId, project.ownerId, {
                name: previewName(repo, pull.number),
                branch: pull.headBranch,
                preview: { pullRequest: pull.number, repo, sha: pull.headSha }
            });
            if (environment.withheld.length > 0) {
                await createNotification({
                    userId: project.ownerId,
                    type: "deploy.preview-secrets",
                    title: `The preview of ${repo}#${pull.number} has no secrets`,
                    body: `Secrets are not copied into pull request previews, so it starts without ${keyList(environment.withheld)}. Set any it needs on the preview.`,
                    href: `/apps/deploy/${project.projectId}?env=${environment.id}`,
                    level: "warning",
                    metadata: { environmentId: environment.id, pullRequest: pull.number, repo }
                });
            }
            const result = await deployEnvironment(
                environment.id,
                project.ownerId,
                project.ownerId,
                {
                    sha: pull.headSha,
                    message: pull.title,
                    authorName: pull.authorName,
                    authorAvatarUrl: pull.authorAvatarUrl
                },
                "preview"
            );
            if (result.failed.length > 0) {
                console.warn(`polaris: preview for ${repo}#${pull.number}: ${result.failed.join("; ")}`);
            }
            created += 1;
        } catch (error) {
            console.error(`polaris: could not create the preview for ${repo}#${pull.number}:`, error);
        }
    }
    return created;
}

/** Remove one preview environment. False when it could not be. */
async function removePreview(environmentId: string, ownerId: string, label: string): Promise<boolean> {
    const { deleteEnvironment } = await import("@/lib/deploy-service");
    try {
        await deleteEnvironment(environmentId, ownerId);
        return true;
    } catch (error) {
        console.error(`polaris: could not remove the preview for ${label}:`, error);
        return false;
    }
}

/**
 * Remove a closed pull request's previews, in every project that has one.
 * Only environments made as its preview are matched. Answers how many went.
 */
export async function closePullRequestPreview(repo: string, number: number): Promise<number> {
    const environments = await prisma.environment.findMany({
        where: { pullRequest: number, previewRepo: repo.toLowerCase(), previewOfId: { not: null } },
        select: { id: true, project: { select: { ownerId: true } } }
    });
    let removed = 0;
    for (const environment of environments) {
        if (await removePreview(environment.id, environment.project.ownerId, `${repo}#${number}`)) removed += 1;
    }
    return removed;
}

/** Where the moment a project started previewing a repository is kept. */
const PREVIEWS_SINCE = "deploy.previews.since.";

/** Whether a pull request was opened at or after `since`. One without a readable
 *  date is not assumed to be new. */
export function openedSince(openedAt: string | null, since: string): boolean {
    if (!openedAt) return false;
    const opened = Date.parse(openedAt);
    const from = Date.parse(since);
    return Number.isFinite(opened) && Number.isFinite(from) && opened >= from;
}

/**
 * Bring previews in line with the pull requests that are actually open, for an
 * install GitHub cannot reach with a webhook.
 *
 * Asked of GitHub per repository and per project owner, the same credential the
 * build clones with. A repository GitHub would not answer for is left exactly as
 * it was: removing previews because a request failed would tear down every one.
 * A preview whose pull request is missing from the list is removed only once
 * GitHub says that pull request is closed.
 *
 * A new preview is made only for a pull request opened since this project
 * started previewing its repository, which is all a webhook would have told it
 * about. Switching previews on is not a reason to build one for every pull
 * request already open.
 */
export async function reconcilePullRequestPreviews(): Promise<void> {
    const [projects, stored] = await Promise.all([
        prisma.project.findMany({
            select: {
                id: true,
                ownerId: true,
                flags: true,
                environments: {
                    select: {
                        id: true,
                        isDefault: true,
                        pullRequest: true,
                        previewRepo: true,
                        previewOfId: true,
                        applications: { select: { sourceConfig: true } }
                    }
                }
            }
        }),
        prisma.setting.findMany({
            where: { key: { startsWith: PREVIEWS_SINCE } },
            select: { key: true, value: true }
        })
    ]);
    const baselines = new Map(stored.map((row) => [row.key, row.value]));
    const openByRepo = new Map<string, OpenPullRequest[] | null>();
    for (const project of projects) {
        const enabled = parseProjectFlags(project.flags).previewEnvironments;
        const base = project.environments.find((one) => one.isDefault);
        const repos = new Set(
            (base?.applications ?? []).flatMap((one) => {
                const repo = repositoryOf(one.sourceConfig);
                return repo ? [repo] : [];
            })
        );
        const previews = project.environments.flatMap((one) =>
            one.pullRequest !== null && one.previewRepo && one.previewOfId
                ? [{ id: one.id, pullRequest: one.pullRequest, repo: one.previewRepo }]
                : []
        );
        // Previews left behind by a project that has since switched them off, or
        // stopped building from that repository, are cleaned up on the same pass.
        for (const preview of previews) {
            if (!enabled || !repos.has(preview.repo)) {
                await removePreview(preview.id, project.ownerId, `${preview.repo}#${preview.pullRequest}`);
            }
        }
        // And so is the moment it started previewing, so switching back on later
        // starts from then rather than from the first time.
        const prefix = `${PREVIEWS_SINCE}${project.id}:`;
        for (const key of [...baselines.keys()]) {
            if (key.startsWith(prefix) && (!enabled || !repos.has(key.slice(prefix.length)))) {
                await setSetting(key, null);
                baselines.delete(key);
            }
        }
        if (!enabled) continue;
        for (const repo of repos) {
            const sinceKey = `${prefix}${repo}`;
            let since = baselines.get(sinceKey);
            if (!since) {
                since = new Date().toISOString();
                await setSetting(sinceKey, since);
                baselines.set(sinceKey, since);
            }
            const [owner, name] = repo.split("/") as [string, string];
            const token = await githubTokenForOwner(project.ownerId, owner);
            const key = `${project.ownerId}:${repo}`;
            if (!openByRepo.has(key)) openByRepo.set(key, await listOpenPullRequests(owner, name, token));
            const open = openByRepo.get(key);
            if (!open) continue;
            const numbers = new Set(open.map((pull) => pull.number));
            for (const preview of previews) {
                if (preview.repo !== repo || numbers.has(preview.pullRequest)) continue;
                if ((await pullRequestIsOpen(owner, name, preview.pullRequest, token)) === false) {
                    await removePreview(preview.id, project.ownerId, `${repo}#${preview.pullRequest}`);
                }
            }
            for (const pull of open) {
                if (previews.some((one) => one.repo === repo && one.pullRequest === pull.number)) continue;
                if (!openedSince(pull.openedAt, since)) continue;
                await ensurePullRequestPreview({ repo, ...pull }, project.id);
            }
        }
    }
}
