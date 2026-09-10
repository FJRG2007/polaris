/**
 * Which branch a repository-built service follows.
 *
 * Three places can say, and they are asked in this order: the environment it is
 * in (a branch environment builds everything from its branch), the service's
 * own auto-deploy branch, then the branch it was created from. Answered in one
 * place because the webhook, the poller and the build all ask, and a service
 * that deploys from one branch while watching another is the kind of bug that
 * looks like auto-deploy being broken.
 */

/** The branch, or "" when nothing names one (the repository's default). */
export function trackedBranch(
    app: { deployBranch: string | null; sourceConfig: string },
    environment: { branch: string | null }
): string {
    if (environment.branch?.trim()) return environment.branch.trim();
    if (app.deployBranch?.trim()) return app.deployBranch.trim();
    try {
        const source = JSON.parse(app.sourceConfig) as Record<string, unknown>;
        return typeof source.branch === "string" ? source.branch.trim() : "";
    } catch {
        return "";
    }
}
