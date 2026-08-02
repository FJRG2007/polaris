"use client";

/**
 * Webhooks: where this project reports its deploys. The panel itself is shared
 * with Watch, which is where the same question is answered for the whole
 * instance - so an endpoint added in either place is the same endpoint.
 */

import Link from "next/link";
import { SettingsCard } from "../project-settings";
import { ProjectWebhooks } from "@/components/project-webhooks";

export function WebhooksSection({ projectId }: { projectId: string }) {
    return (
        <SettingsCard
            title="Webhooks"
            description="Endpoints that receive this project's deploy events. They belong to the project, so they keep reporting after whoever added them is gone."
        >
            <ProjectWebhooks projectId={projectId} />
            <p className="text-xs text-muted-foreground">
                Every endpoint across every project is listed together in{" "}
                <Link href="/watch/webhooks" className="text-primary hover:underline">
                    Watch
                </Link>
                .
            </p>
        </SettingsCard>
    );
}
