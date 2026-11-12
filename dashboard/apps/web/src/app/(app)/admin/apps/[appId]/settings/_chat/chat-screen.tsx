/**
 * One screen of Chat's administrator settings, as a page: the header now, the
 * screen's settings under it. The rail beside it lists the other screens.
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@polaris/ui";
import { getTranslations } from "@/lib/i18n/request";
import { ChatAdminSettings, type ChatAdminScreen } from "./chat-settings";

export async function ChatSettingsPage({ screen }: { screen: ChatAdminScreen }) {
    const [t, admin] = await Promise.all([
        getTranslations("marketplace"),
        getTranslations("admin")
    ]);
    return (
        <div className="mx-auto flex w-full min-w-0 max-w-2xl flex-col gap-4">
            <Link
                href="/admin/apps"
                className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1 text-sm"
            >
                <ArrowLeft className="size-4" />
                {t("polaris.title")}
            </Link>
            <PageHeader
                title={admin("chat.page.title")}
                description={admin("chat.page.description")}
            />
            <ChatAdminSettings screen={screen} />
        </div>
    );
}
