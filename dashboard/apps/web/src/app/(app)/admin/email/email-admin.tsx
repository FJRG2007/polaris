"use client";

/**
 * The account-mail picker. One choice, so the page is one card - a dropdown of
 * the email channels that exist, plus what happens if none is chosen.
 *
 * A channel whose last check failed is still offered, marked as such: the fix is
 * usually a field on the channel, and forcing the operator to repair it before
 * they can even nominate it would be the wrong order to work in.
 */

import Link from "next/link";
import { useState, useTransition } from "react";
import { MAIL_PROVIDER_INFO } from "@polaris/core";
import { setAuthMailChannelAction } from "./actions";
import type { EmailChannelView } from "@/lib/mail-service";
import { Button, Card, CardBody, PageHeader, Select } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";

const NONE = "none";

export function AccountMailView({
    channels,
    selectedId
}: {
    channels: EmailChannelView[];
    selectedId: string | null;
}) {
    const t = useTranslations("admin");
    const tc = useTranslations("common");
    const [choice, setChoice] = useState(selectedId ?? NONE);
    const [saved, setSaved] = useState(selectedId ?? NONE);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [saving, startSave] = useTransition();

    const options = [
        { value: NONE, label: t("email.none") },
        ...channels.map((channel) => ({
            value: channel.id,
            label: t(channel.status === "connected" ? "email.channel" : "email.channelBroken", {
                name: channel.name,
                provider: MAIL_PROVIDER_INFO[channel.provider].label
            })
        }))
    ];

    function save() {
        setError(null);
        setNotice(null);
        startSave(async () => {
            const result = await setAuthMailChannelAction(choice === NONE ? null : choice);
            if (result.error) {
                setError(result.error);
                return;
            }
            setSaved(choice);
            setNotice(t("email.saved"));
        });
    }

    return (
        // Narrow page: centre the column in the content area, header included.
        <div className="mx-auto flex w-full max-w-2xl flex-col">
            <PageHeader
                title={t("email.title")}
                description={t("email.description")}
            />
            <Card>
                <CardBody className="flex flex-col gap-3">
                    {channels.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            {t.rich("email.empty", {
                                link: (chunks) => (
                                    <Link key="link" href="/admin/inbox/channels" className="text-primary hover:underline">
                                        {chunks}
                                    </Link>
                                )
                            })}
                        </p>
                    ) : (
                        <>
                            <label className="flex flex-col gap-1 text-sm">
                                <span className="font-medium">{t("email.sendThrough")}</span>
                                <Select value={choice} onValueChange={setChoice} options={options} />
                            </label>
                            <p className="text-xs text-muted-foreground">{t("email.hint")}</p>
                            {error ? <p className="text-sm text-danger">{error}</p> : null}
                            {notice ? <p className="text-sm text-success">{notice}</p> : null}
                            <div className="flex justify-end">
                                <Button onClick={save} disabled={saving || choice === saved}>
                                    {saving ? tc("actions.saving") : tc("actions.save")}
                                </Button>
                            </div>
                        </>
                    )}
                </CardBody>
            </Card>
        </div>
    );
}
