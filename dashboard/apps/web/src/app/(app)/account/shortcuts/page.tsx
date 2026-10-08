/**
 * Keyboard shortcuts (/account/shortcuts): every app's keys in one list, to
 * look up and to move. The same screen each app's `?` opens on that app alone.
 */

import { requireUser } from "@/lib/session";
import { Messages } from "@/components/i18n/messages";
import { getTranslations } from "@/lib/i18n/request";
import { ShortcutSettings } from "@/components/shortcuts/shortcut-settings";

export const dynamic = "force-dynamic";

export default async function ShortcutsPage() {
    await requireUser();
    const t = await getTranslations("shortcuts");
    return (
        <Messages namespaces={["shortcuts"]}>
            <div className="mx-auto flex max-w-5xl flex-col gap-4">
                <div>
                    <h1 className="text-[17px] font-semibold tracking-tight">{t("title")}</h1>
                    <p className="text-sm text-muted-foreground">{t("description")}</p>
                </div>
                <ShortcutSettings showAppFilter />
            </div>
        </Messages>
    );
}
