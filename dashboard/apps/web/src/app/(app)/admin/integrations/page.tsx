/**
 * Integrations marketplace. Lists the integrations Polaris can run and their
 * installed state. Admin-only: configuring one stores an instance-wide secret.
 */

import Link from "next/link";
import { IntegrationsLoader } from "./loader";
import { requireAdmin } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage({
    searchParams
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    await requireAdmin();
    // `?configure=<slug>` opens that service's setup straight away: what another
    // screen links to when it has just said the service is not set up yet.
    const asked = (await searchParams).configure;
    const configure = typeof asked === "string" && /^[a-z0-9-]{1,40}$/.test(asked) ? asked : null;
    const t = await getTranslations("admin");

    return (
        <div className="mx-auto flex max-w-4xl flex-col gap-6">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">
                    {t("integrations.page.title")}
                </h1>
                <p className="text-muted-foreground text-sm">
                    {t.rich("integrations.page.intro", {
                        link: (chunks) => (
                            <Link
                                key="link"
                                href="/admin/integrations/models"
                                className="text-primary hover:underline"
                            >
                                {chunks}
                            </Link>
                        )
                    })}
                </p>
            </div>
            <IntegrationsLoader configure={configure} revision={Date.now()} />
        </div>
    );
}
