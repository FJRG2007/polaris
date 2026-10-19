import type { Metadata } from "next";
import { requireUser } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { PolarChat } from "@/components/polar/polar-panel";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("polar");
    return { title: t("page.title") };
}

/** Polar as a page of its own, with the conversation list beside it. */
export default async function PolarPage() {
    await requireUser();
    return (
        <div className="-m-3 flex h-below-header overflow-hidden bg-card sm:-m-4 md:-mx-6 md:-my-5">
            <PolarChat fullPage />
        </div>
    );
}
