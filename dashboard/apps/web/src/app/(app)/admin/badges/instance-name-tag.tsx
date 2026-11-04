"use client";

/** The instance's own name tag, on the badges admin screen. */

import { useTranslations } from "@/components/i18n/i18n-provider";
import { NameTagEditor, type NameTagFormValue } from "@/components/name-tags/name-tag-editor";
import { setInstanceNameTagAction } from "./actions";

export function InstanceNameTag({ initial }: { initial: NameTagFormValue }) {
    const t = useTranslations("badges");
    return (
        <NameTagEditor
            title={t("nameTags.instance.title")}
            intro={t("nameTags.instance.intro")}
            initial={initial}
            staff
            onSave={(value) => setInstanceNameTagAction(value)}
        />
    );
}
