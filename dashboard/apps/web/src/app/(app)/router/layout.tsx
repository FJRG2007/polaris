/** Every screen of the Router app, an administrator's alone. */

import type { ReactNode } from "react";
import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { Messages } from "@/components/i18n/messages";

export const dynamic = "force-dynamic";

export default async function RouterLayout({ children }: { children: ReactNode }) {
    await requireAdmin();
    const t = await getTranslations("router");
    return (
        <Messages namespaces={["router"]}>
            <div className="mx-auto flex w-full max-w-5xl flex-col">
                <PageHeader title={t("title")} description={t("description")} />
                {children}
            </div>
        </Messages>
    );
}
