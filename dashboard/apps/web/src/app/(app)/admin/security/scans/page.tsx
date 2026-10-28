/**
 * Management > Security scans: what the vulnerability scans found in the
 * images Polaris itself runs on this machine - the dashboard, the host
 * service, the updater - each with its findings and a way to scan it again.
 * The list is read in the browser, so the page paints at once.
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { OwnImagesView } from "./own-images-view";
import { Messages } from "@/components/i18n/messages";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

export default async function PolarisImagesPage() {
    await requireAdmin();
    const t = await getTranslations("admin");
    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col">
            <PageHeader title={t("images.title")} description={t("images.description")} />
            <Messages namespaces={["imageScans"]}>
                <OwnImagesView />
            </Messages>
        </div>
    );
}
