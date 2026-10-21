import type { Metadata } from "next";
import { PAGE_BLEED, cn } from "@polaris/ui";
import { redirect } from "next/navigation";
import { polarAccessFor } from "@/lib/polar/access";
import { homePathForUser, requireUser } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { PolarChat } from "@/components/polar/polar-panel";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("polar");
    return { title: t("page.title") };
}

/** Polar as a page of its own, with the conversation list beside it. */
export default async function PolarPage() {
    const user = await requireUser();
    if (!(await polarAccessFor(user.id)).use) redirect(await homePathForUser(user));
    return (
        <div className={cn(PAGE_BLEED, "flex bg-card")}>
            <PolarChat fullPage />
        </div>
    );
}
