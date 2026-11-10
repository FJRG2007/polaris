/**
 * Polar's settings, one page per section under /polar/settings/<section>.
 *
 * The sidebar beside them lists those pages instead of the chats, as every
 * Polaris app's settings do: being in the settings is a place of its own, and
 * Back to chat leaves it. The layout stays put while a page changes, so only
 * the page waits on its own loading shape.
 */

import type { ReactNode } from "react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PAGE_BLEED, cn } from "@polaris/ui";
import { SectionFromHash } from "./section-from-hash";
import { SettingsWithSidebar } from "./settings-sidebar";
import { getTranslations } from "@/lib/i18n/request";
import { polarAccessFor } from "@/lib/polar/access";
import { homePathForUser, requireUser } from "@/lib/session";
import { POLAR_SETTINGS_SECTIONS } from "@/lib/polar/settings-path";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("polar");
    return { title: t("settings.title") };
}

export default async function PolarSettingsLayout({ children }: { children: ReactNode }) {
    const user = await requireUser();
    const access = await polarAccessFor(user.id);
    if (!access.use) redirect(await homePathForUser(user));
    const connectorsListed = access.connectors && !user.viewingAs;
    const sections = POLAR_SETTINGS_SECTIONS.filter(
        (id) => connectorsListed || id !== "connectors"
    );
    return (
        <div className={cn(PAGE_BLEED, "flex")}>
            <SettingsWithSidebar sections={sections}>
                <SectionFromHash ids={sections} />
                <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-6">
                    {children}
                </div>
            </SettingsWithSidebar>
        </div>
    );
}
