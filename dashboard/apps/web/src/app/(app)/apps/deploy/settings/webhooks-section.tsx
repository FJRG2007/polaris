"use client";

/**
 * Webhooks: where this project reports its deploys. The panel itself is shared
 * with Watch, which is where the same question is answered for the whole
 * instance - so an endpoint added in either place is the same endpoint.
 */

import Link from "next/link";
import { SettingsCard } from "../project-settings";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ProjectWebhooks } from "@/components/project-webhooks";

export function WebhooksSection({ projectId }: { projectId: string }) {
    const t = useTranslations("deploySettings");
    return (
        <SettingsCard title={t("webhooks.title")} description={t("webhooks.description")}>
            <ProjectWebhooks projectId={projectId} />
            <p className="text-xs text-muted-foreground">
                {t.rich("webhooks.everywhere", {
                    link: (chunks) => (
                        <Link key="watch" href="/watch/webhooks" className="text-primary hover:underline">
                            {chunks}
                        </Link>
                    )
                })}
            </p>
        </SettingsCard>
    );
}
