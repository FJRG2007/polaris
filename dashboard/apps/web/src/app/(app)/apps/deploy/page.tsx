import { PageHeader } from "@polaris/ui";
import { requirePermission } from "@/lib/session";
import { listDeployTargets } from "@/lib/deploy-target-service";

export const dynamic = "force-dynamic";

// Landing shell for the unified Deploy app. Projects, environments, the deploy
// pipeline, terminals, and the file browser land in later phases; this phase
// establishes the route and the target model that everything hangs off.
export default async function DeployPage() {
    const user = await requirePermission("deploy.read");
    const targets = await listDeployTargets(user.id);

    return (
        <>
            <PageHeader
                title="Deploy"
                description="Deploy apps and databases across your local host and remote servers."
            />
            <p className="text-sm text-muted-foreground">
                {targets.length === 0
                    ? "No targets yet. Add a server or enable the local host to start deploying."
                    : `${targets.length} target${targets.length === 1 ? "" : "s"} ready.`}
            </p>
        </>
    );
}
