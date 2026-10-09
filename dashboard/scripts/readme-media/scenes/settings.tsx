/** Settings: the deployment's own page, with an update waiting. */

import { PageHeader } from "@polaris/ui";
import { Chrome } from "../runtime/chrome";
import { label } from "../runtime/interact";
import { defineScene } from "../runtime/scene";
import { VIEWER } from "../fixtures/people";
import { SettingsView } from "@/app/(app)/admin/settings/settings-view";
import { TransferCard } from "@/app/(app)/admin/settings/transfer-card";
import { SeasonalAdminCard } from "@/app/(app)/admin/settings/seasonal-card";
import { DEPLOYMENT, quietUpdateLog, settingsOverview, updateStatus } from "../fixtures/settings";

export const settings = defineScene({
    id: "settings",
    path: "/admin/settings",
    actions: (ctx) => ({ checkUpdatesAction: () => updateStatus(ctx) }),
    api: (ctx) => ({
        "GET /api/admin/settings/overview": () => settingsOverview(ctx),
        "GET /api/updates/logs": () => quietUpdateLog(ctx)
    }),
    // The page `/admin/settings` draws, with what it would have read.
    render: (ctx) => (
        <Chrome>
            <div className="mx-auto flex w-full max-w-2xl flex-col">
                <PageHeader
                    title={label(ctx.locale, "admin.settings.page.title")}
                    description={label(ctx.locale, "admin.settings.page.description")}
                />
                <SettingsView
                    initialPolicy={{ mode: "daily", at: "05:00" }}
                    initialSource="image"
                    initialContact="privacy@example.com"
                    publicPages={{
                        home: "https://polaris.example.com/about",
                        privacy: "https://polaris.example.com/legal/privacy",
                        terms: "https://polaris.example.com/legal/terms"
                    }}
                    deployment={DEPLOYMENT}
                />
                <SeasonalAdminCard initial />
                <TransferCard identity={[VIEWER.email, VIEWER.name]} />
            </div>
        </Chrome>
    )
});
