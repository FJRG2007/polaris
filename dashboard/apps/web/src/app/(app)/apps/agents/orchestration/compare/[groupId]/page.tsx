import { z } from "zod";
import { notFound } from "next/navigation";
import { PageHeader } from "@polaris/ui";
import { CompareView } from "./compare-view";
import { requirePermission } from "@/lib/session";
import { getSession } from "@/lib/agents/session-service";
import { variantGroup } from "@/lib/agents/orchestration-service";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

export default async function CompareVariantsPage({
    params
}: {
    params: Promise<{ groupId: string }>;
}) {
    const user = await requirePermission("agents.read");
    const { groupId } = await params;
    if (!z.string().uuid().safeParse(groupId).success) notFound();
    const variants = await variantGroup(groupId, user.id);
    if (variants.length === 0) notFound();
    const sessions = await Promise.all(
        variants.map((variant) =>
            variant.sessionId ? getSession(variant.sessionId, user.id) : Promise.resolve(null)
        )
    );
    const t = await getTranslations("agents");
    const title = variants[0]!.title.replace(/ \([^)]*\)$/, "");

    return (
        <>
            <PageHeader title={t("orchestration.compareTitle", { title })} description={t("pages.compare")} />
            <CompareView
                variants={variants.map((variant, index) => ({ ...variant, session: sessions[index] ?? null }))}
            />
        </>
    );
}
