"use client";

/**
 * Whether links this account sends are drawn as cards (ledger row 4). Off means
 * the server never looks the address up and nobody's screen loads the site.
 * Shown greyed out with the reason when the instance has previews off for all.
 */

import { useState } from "react";
import { Link2Off } from "lucide-react";
import { runAction } from "@/lib/run-action";
import { saveLinkPreviewsAction } from "@/app/(app)/account/privacy/actions";
import { Card, CardBody, SettingRow, Switch } from "@polaris/ui";
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
            <CardBody className="p-3">
                <SettingRow
                    id="chat-link-previews"
                    icon={<Link2Off />}
                    label={t("linkPreviews.label")}
                    hint={forbidden ? t("linkPreviews.forbidden") : t("linkPreviews.hint")}
                    error={error}
                >
                    <Switch
                        checked={value && !forbidden}
                        disabled={saving || forbidden}
                        aria-label={t("linkPreviews.label")}
                        aria-describedby="chat-link-previews-hint"
                        onChange={(next) => void save(next)}
                    />
                </SettingRow>
            </CardBody>
        </Card>
    );
}
