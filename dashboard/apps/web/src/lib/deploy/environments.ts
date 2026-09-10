/**
 * Environments made from other environments: a branch environment, and the one
 * a pull request gets.
 *
 * A clone is the environment's shape without its data. Every service comes over
 * with its source, build settings, variables and volumes; every managed
 * database comes over as a new, empty one with credentials of its own. Nothing
 * is shared with the environment it came from - not a volume, not a database,
 * not a secret's plaintext - so a preview can be broken, migrated and thrown
 * away without production noticing.
 *
 * Variables are copied as they were written. One written as a reference
 * (`${{postgres.DATABASE_URL}}`) is resolved again in the clone and finds the
 * clone's database; one written as a literal address still points wherever it
 * pointed. The preview settings say so, because that is the one way a clone can
 * reach back into production.
 */

import { prisma } from "@polaris/db";
import { slugify } from "@polaris/deploy";
import { copyScopeValues } from "./env-values";
import { parseGithubRepo } from "../repo-reference";
import { githubTokenForOwner } from "../github-access";
import { isGitBranchName, parseProjectFlags } from "@polaris/core";
import { listOpenPullRequests, type OpenPullRequest } from "../github-service";

/** What makes an environment a preview. */
export interface PreviewOrigin {
    readonly pullRequest: number;
    /** "owner/repo" the pull request was opened on. */
    readonly repo: string;
}

/**
 * Copy an environment's services and databases into a new environment.
 *
 * `branch` makes every repository-built service in the clone build from and
 * follow that branch. Nothing is deployed here; the caller decides when.
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
): Promise<{ id: string; slug: string }> {
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

    const environment = await prisma.environment.create({
        data: {
            projectId: source.projectId,
            name,
            slug,
            isDefault: false,
            layout: source.layout,
            branch: input.branch?.trim() || null,
            pullRequest: input.preview?.pullRequest ?? null,
            previewRepo: input.preview?.repo ?? null,
            previewOfId: input.preview ? source.id : null
        }
    });
    await copyScopeValues(
        { scopeType: "environment", scopeId: source.id },
        { scopeType: "environment", scopeId: environment.id }
    );

    // Databases first, instances before the databases hosted inside them, so a
    // hosted one can be pointed at its clone's instance.
    const { createDatabase } = await import("@/lib/database-service");
    const instances = new Map<string, string>();
    const ordered = [...source.databases].sort((a, b) => Number(Boolean(a.parentId)) - Number(Boolean(b.parentId)));
    for (const database of ordered) {
        const instanceId = database.parentId ? instances.get(database.parentId) : undefined;
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
        instances.set(database.id, created.id);
    }

    // Cycle: the deploy service reaches this module.
    const { createApplication } = await import("@/lib/deploy-service");
    const { createVolume } = await import("@/lib/deploy-volume-service");
    for (const application of source.applications) {
        const repositoryBuilt = application.sourceType === "dockerfile" || application.sourceType === "nixpacks";
        const created = await createApplication(ownerId, {
            environmentId: environment.id,
            targetId: application.targetId,
            name: application.name,
            sourceType: application.sourceType,
            sourceConfig: JSON.parse(application.sourceConfig) as Record<string, unknown>,
            // A clone follows its branch; that is what it is for.
            autoDeploy: repositoryBuilt ? true : application.autoDeploy,
            deployBranch: null,
            keepReleases: false
        });
        await prisma.application.update({
            where: { id: created.id },
            data: {
                buildConfig: application.buildConfig,
                healthcheck: application.healthcheck,
                replicas: application.replicas,
                commitFilter: application.commitFilter,
                watchPaths: application.watchPaths,
                // The edge settings and whether the port is open come over too:
                // a copy that answered on a port its original keeps closed, or
                // without the original's rate limits, is not a copy.
                publishPort: application.publishPort,
                edgeConfig: application.edgeConfig
            }
        });
        await copyScopeValues(
            { scopeType: "application", scopeId: application.id },
            { scopeType: "application", scopeId: created.id }
        );
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
    return { id: environment.id, slug: environment.slug };
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

/**
 * Make sure a pull request has its preview, in every project that wants one.
 *
 * Idempotent: an environment already there is left alone, because keeping it
 * current is ordinary auto-deploy - its services follow the pull request's
 * branch, so a push to it deploys them like any other push. Answers how many
 * previews were created.
 */
export async function ensurePullRequestPreview(pull: {
    repo: string;
    number: number;
    title: string;
    headBranch: string;
    headSha: string;
    headRepo: string;
    authorName?: string | null;
    authorAvatarUrl?: string | null;
}): Promise<number> {
    if (pull.headRepo && pull.headRepo.toLowerCase() !== pull.repo.toLowerCase()) {
        console.info(`polaris: ${pull.repo}#${pull.number}: ${FORK_REFUSAL}`);
        return 0;
    }
    // The branch reaches `git clone --branch`; a name git would refuse is not
    // passed on to it.
    if (!isGitBranchName(pull.headBranch)) return 0;
    let created = 0;
    for (const project of await projectsPreviewing(pull.repo)) {
        const existing = await prisma.environment.findFirst({
            where: { projectId: project.projectId, pullRequest: pull.number, previewRepo: pull.repo.toLowerCase() },
            select: { id: true }
        });
        if (existing) continue;
        try {
            const environment = await cloneEnvironment(project.baseEnvironmentId, project.ownerId, {
                name: `PR ${pull.number}`,
                branch: pull.headBranch,
                preview: { pullRequest: pull.number, repo: pull.repo.toLowerCase() }
            });
            await prisma.environment.update({ where: { id: environment.id }, data: { previewSha: pull.headSha } });
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
                console.warn(`polaris: preview for ${pull.repo}#${pull.number}: ${result.failed.join("; ")}`);
            }
            created += 1;
        } catch (error) {
            console.error(`polaris: could not create the preview for ${pull.repo}#${pull.number}:`, error);
        }
    }
    return created;
}

/** Remove a pull request's previews, everywhere. Answers how many went. */
export async function closePullRequestPreview(repo: string, number: number): Promise<number> {
    const environments = await prisma.environment.findMany({
        where: { pullRequest: number, previewRepo: repo.toLowerCase() },
        select: { id: true, project: { select: { ownerId: true } } }
    });
    const { deleteEnvironment } = await import("@/lib/deploy-service");
    let removed = 0;
    for (const environment of environments) {
        try {
            await deleteEnvironment(environment.id, environment.project.ownerId);
            removed += 1;
        } catch (error) {
            console.error(`polaris: could not remove the preview for ${repo}#${number}:`, error);
        }
    }
    return removed;
}

/**
 * Bring previews in line with the pull requests that are actually open, for an
 * install GitHub cannot reach with a webhook.
 *
 * Asked of GitHub per repository and per project owner, the same credential the
 * build clones with. A repository GitHub would not answer for is left exactly as
 * it was: removing previews because a request failed would tear down every one.
 */
export async function reconcilePullRequestPreviews(): Promise<void> {
    const projects = await prisma.project.findMany({
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
                    applications: { select: { sourceConfig: true } }
                }
            }
        }
    });
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
        // Previews left behind by a project that has since switched them off, or
        // stopped building from that repository, are cleaned up on the same pass.
        for (const environment of project.environments) {
            if (environment.pullRequest === null || !environment.previewRepo) continue;
            if (!enabled || !repos.has(environment.previewRepo)) {
                await closePullRequestPreview(environment.previewRepo, environment.pullRequest);
            }
        }
        if (!enabled) continue;
        for (const repo of repos) {
            const key = `${project.ownerId}:${repo}`;
            if (!openByRepo.has(key)) {
                const [owner, name] = repo.split("/") as [string, string];
                const token = await githubTokenForOwner(project.ownerId, owner);
                openByRepo.set(key, await listOpenPullRequests(owner, name, token));
            }
            const open = openByRepo.get(key);
            if (!open) continue;
            const numbers = new Set(open.map((pull) => pull.number));
            for (const environment of project.environments) {
                if (environment.previewRepo === repo && environment.pullRequest !== null && !numbers.has(environment.pullRequest)) {
                    await closePullRequestPreview(repo, environment.pullRequest);
                }
            }
            for (const pull of open) {
                const has = project.environments.some(
                    (one) => one.previewRepo === repo && one.pullRequest === pull.number
                );
                if (!has) await ensurePullRequestPreview({ repo, ...pull });
            }
        }
    }
}
