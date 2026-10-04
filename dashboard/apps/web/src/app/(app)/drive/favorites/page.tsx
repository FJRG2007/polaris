import { PageHeader } from "@polaris/ui";
import { FavoritesView } from "./favorites-view";
import { getTranslations } from "@/lib/i18n/request";
import { listFavorites } from "@/lib/drive-meta-service";
import { requirePermission, sessionCan } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function FavoritesPage() {
    const t = await getTranslations("drive");
    const user = await requirePermission("drive.read");
    const [favorites, canEdit] = await Promise.all([
        listFavorites(user.id),
        // The same permission the star action checks, so the star is offered
        // only to somebody it will answer.
        sessionCan(user, "drive.write")
    ]);

    return (
        <>
            <PageHeader
                title={t("pages.favorites.title")}
                description={t("pages.favorites.description")}
            />
            <FavoritesView favorites={favorites} canEdit={canEdit} />
        </>
    );
}
