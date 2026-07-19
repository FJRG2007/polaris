import { PageHeader } from "@polaris/ui";
import { requirePermission } from "@/lib/session";
import { getIntegrationState } from "@/lib/integration-service";
import { IntegrationsView } from "./integrations-view";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
    await requirePermission("integrations.manage");
    const virustotal = await getIntegrationState("virustotal");

    return (
        <>
            <PageHeader
                title="Integrations"
                description="Connect Polaris to the services you already use. More integrations are on the way."
            />
            <IntegrationsView virustotal={virustotal} />
        </>
    );
}
