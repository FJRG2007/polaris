import { PageHeader } from "@polaris/ui";
import { RunnersView } from "./runners-view";
import { listHosts } from "@/lib/host-service";
import { requirePermission } from "@/lib/session";
import { getRunnerAccess } from "@/lib/github-runners";
import { listRunnerPools } from "@/lib/runners/runner-service";

export const dynamic = "force-dynamic";

export default async function RunnersPage() {
    const user = await requirePermission("system.manage");
    const [pools, hosts, access] = await Promise.all([
        listRunnerPools(user.id),
        listHosts(user.id),
        // Read once here rather than in the form: the operator should learn a
        // permission is missing before they fill anything in, and this is the same
        // evaluation the GitHub card on Integrations shows.
        getRunnerAccess().catch(() => null)
    ]);

    return (
        <>
            <PageHeader
                title="Runners"
                description="Run GitHub Actions workflows on your own servers. Each job gets a runner that registers, takes that one job, and disappears."
            />
            <RunnersView
                pools={pools}
                servers={hosts.map((host) => ({ id: host.id, name: host.name }))}
                accessReady={access?.ready ?? false}
                accessAdvice={access?.advice ?? null}
            />
        </>
    );
}
