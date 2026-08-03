import { prisma } from "@polaris/db";
import { PageHeader } from "@polaris/ui";
import { SecretsView } from "./secrets-view";
import { requirePermission } from "@/lib/session";
import { listRunnerSecrets } from "@/lib/runners/runner-secrets";

export const dynamic = "force-dynamic";

/**
 * The values a pool's runners carry into a job.
 *
 * The list is names and scopes only - a value is never sent to a browser as part
 * of a listing, and reading one back is a deliberate act with its own audit line.
 */
export default async function RunnerSecretsPage() {
    const user = await requirePermission("system.manage");
    const pools = await prisma.runnerPool.findMany({
        where: { ownerId: user.id },
        select: { id: true, name: true, scope: true, targets: { select: { key: true }, orderBy: { key: "asc" } } },
        orderBy: { createdAt: "asc" }
    });

    const withSecrets = await Promise.all(
        pools.map(async (pool) => ({
            id: pool.id,
            name: pool.name,
            // An organization-level pool registers one runner for every repository
            // at once, so nothing it carries can be narrowed to one of them.
            perRepo: pool.scope !== "org",
            targets: pool.targets.map((target) => target.key),
            secrets: await listRunnerSecrets(pool.id, user.id)
        }))
    );

    return (
        <>
            <PageHeader
                title="Secrets"
                description="Values your runners carry into a job. Set once, readable by the repositories you choose."
            />
            <SecretsView pools={withSecrets} />
        </>
    );
}
