"use client";

/**
 * Whether links this account sends are drawn as cards (ledger row 4). Off means
 * the server never looks the address up and nobody's screen loads the site.
 * Shown greyed out with the reason when the instance has previews off for all.
 */

import { useState } from "react";
import { Link2Off } from "lucide-react";
import { runAction } from "@/lib/run-action";
import { saveLinkPreviewsAction } from "./actions";
import { Card, CardBody, Switch } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function LinkPreviewsCard({ on, forbidden }: { on: boolean; forbidden: boolean }) {
    const t = useTranslations("accountPrivacy");
    const [value, setValue] = useState(on);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    const save = async (next: boolean) => {
        if (next === value) return;
        const before = value;
        setValue(next);
        setError("");
        setSaving(true);
        const result = await runAction(() => saveLinkPreviewsAction(next), setError);
        setSaving(false);
        if (!result || result.error) {
            if (result?.error) setError(result.error);
            setValue(before);
        }
    };

    return (
        <Card>
            <CardBody className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
                <Link2Off className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-[14rem] flex-1">
                    <span className="block text-[0.8125rem]">{t("linkPreviews.label")}</span>
                    <span className="block text-[0.6875rem] leading-snug text-foreground-subtle">
                        {forbidden ? t("linkPreviews.forbidden") : t("linkPreviews.hint")}
                    </span>
                    {error && (
                        <span role="alert" className="block text-xs text-danger">
                            {error}
                        </span>
                    )}
                </span>
                <Switch
                    checked={value && !forbidden}
                    disabled={saving || forbidden}
                    aria-label={t("linkPreviews.label")}
                    onChange={(next) => void save(next)}
                />
            </CardBody>
        </Card>
    );
}
