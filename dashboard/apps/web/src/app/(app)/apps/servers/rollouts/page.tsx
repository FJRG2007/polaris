import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { RolloutsView } from "./rollouts-view";
import { Button, PageHeader } from "@polaris/ui";
import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

/** Agent rollouts and the command queue. Platform admins only; the page paints
 *  its headings at once and the servers, the rollout and the queue arrive after. */
export default async function AgentRolloutsPage() {
    await requirePermission("system.manage");
    const t = await getTranslations("agentRollouts");
    return (
        <>
            <PageHeader
                title={t("page.heading")}
                description={t("page.description")}
                actions={
                    <Button asChild variant="ghost" size="sm">
                        <Link href="/apps/servers">
                            <ChevronLeft className="size-4 shrink-0" aria-hidden />
                            {t("page.back")}
                        </Link>
                    </Button>
                }
            />
            <RolloutsView />
        </>
    );
}
