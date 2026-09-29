/**
 * Writing a new snippet (/drive/snippets/new).
 */

import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { SnippetEditor } from "../snippet-editor";

export const dynamic = "force-dynamic";

export default async function NewSnippetPage() {
    const t = await getTranslations("drive");
    await requirePermission("snippets.write");

    return (
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t("pages.snippets.newTitle")}</h1>
                <p className="text-sm text-muted-foreground">
                    {t("pages.snippets.newDescription")}
                </p>
            </div>
            <SnippetEditor />
        </div>
    );
}
