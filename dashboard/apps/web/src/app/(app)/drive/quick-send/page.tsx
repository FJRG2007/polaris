/**
 * Quick send (/drive/quick-send): files shared by link or sent to people, that
 * delete themselves after an expiry or a number of downloads. Nothing here is a
 * Drive item.
 */

import { QuickSendView } from "./quick-send-view";
import { getTranslations } from "@/lib/i18n/request";
import { requirePermission, sessionCan } from "@/lib/session";
import { listTransfers, MAX_TRANSFER_BYTES } from "@/lib/disposable-transfer-service";

export const dynamic = "force-dynamic";

export default async function QuickSendPage() {
    const t = await getTranslations("drive");
    const user = await requirePermission("drive.read");

    return (
        <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-4">
            <div className="min-w-0">
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">
                    {t("disposable.title")}
                </h1>
                <p className="text-sm text-muted-foreground">{t("disposable.description")}</p>
            </div>
            <QuickSendView
                initial={await listTransfers(user.id)}
                canSend={await sessionCan(user, "drive.write")}
                maxBytes={MAX_TRANSFER_BYTES}
            />
        </div>
    );
}
