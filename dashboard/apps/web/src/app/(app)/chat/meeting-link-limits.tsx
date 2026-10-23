"use client";

/**
 * The guest link's limits, for its host: the shared Advanced section with the
 * password and the address rules. Expiry and a cap are left out because the
 * link already dies with the call. Loads and saves on its own, so it can sit
 * wherever the link is handed out. The link's own page and both joins enforce
 * it (`lib/chat/meeting-link-access`).
 */

import { Button } from "@polaris/ui";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { MeetingLinkLimitsView } from "@/lib/chat/meeting-link-access";
import { getGuestLinkLimitsAction, setGuestLinkLimitsAction } from "./meeting-actions";
import {
    LinkAdvancedFields,
    EMPTY_LINK_ADVANCED,
    linkAddressRules,
    type LinkAdvancedValue
} from "@/components/link-advanced-fields";

function valueOf(limits: MeetingLinkLimitsView | null): LinkAdvancedValue {
    if (!limits) return EMPTY_LINK_ADVANCED;
    return {
        ...EMPTY_LINK_ADVANCED,
        allowedCidrs: limits.allowedCidrs,
        allowedCountries: limits.allowedCountries,
        allowedContinents: limits.allowedContinents
    };
}

export function MeetingLinkLimits({ meetingId }: { meetingId: string }) {
    const t = useTranslations("chat");
    const [saved, setSaved] = useState<MeetingLinkLimitsView | null>(null);
    const [value, setValue] = useState<LinkAdvancedValue>(EMPTY_LINK_ADVANCED);
    const [saving, setSaving] = useState(false);
    const [done, setDone] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        let live = true;
        void getGuestLinkLimitsAction(meetingId).then((result) => {
            if (!live) return;
            if (result.error) setError(result.error);
            else if (result.limits) {
                setSaved(result.limits);
                setValue(valueOf(result.limits));
            }
        });
        return () => {
            live = false;
        };
    }, [meetingId]);

    // A typed password is always a change: a stored one cannot be read back.
    const changed =
        saved !== null && (value.password !== "" || JSON.stringify(value) !== JSON.stringify(valueOf(saved)));

    const save = async () => {
        setSaving(true);
        setError("");
        setDone(false);
        const result = await runAction(
            () =>
                setGuestLinkLimitsAction(meetingId, {
                    ...(value.password ? { password: value.password } : {}),
                    ...linkAddressRules(value)
                }),
            setError
        );
        setSaving(false);
        if (!result) return;
        if (result.error) return setError(result.error);
        if (result.limits) {
            setSaved(result.limits);
            setValue(valueOf(result.limits));
            setDone(true);
        }
    };

    return (
        <div className="flex flex-col gap-2">
            <LinkAdvancedFields
                value={value}
                onChange={(next) => {
                    setValue(next);
                    setDone(false);
                }}
                omit={["expiry", "uses"]}
                passwordSet={saved?.hasPassword ?? false}
                idPrefix={`meeting-${meetingId}`}
            />
            {error && (
                <p role="alert" className="text-xs text-danger">
                    {error}
                </p>
            )}
            <div className="flex items-center justify-end gap-2">
                {done && <span className="text-xs text-muted-foreground">{t("meetingLink.saved")}</span>}
                <Button size="sm" variant="secondary" disabled={saving || !changed} onClick={() => void save()}>
                    {saving && <Loader2 className="size-4 animate-spin" />}
                    {t("meetingLink.save")}
                </Button>
            </div>
        </div>
    );
}
