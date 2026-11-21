"use client";

/**
 * The Privacy Checkup's steps. Each privacy step shows its group's rows with
 * the recommendation beside them; "Use recommended" fills the step, Save keeps
 * it, and nothing is written until Save. A field the administrator locked is
 * shown and not offered. The last step points at the account's security.
 */

import Link from "next/link";
import { useState } from "react";
import * as core from "@polaris/core";
import { runAction } from "@/lib/run-action";
import { savePrivacyAction } from "../actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, Card, CardBody, Select, useToast } from "@polaris/ui";
import { ArrowLeft, KeyRound, MonitorSmartphone, ShieldCheck } from "lucide-react";

const SECURITY_STEP = core.PRIVACY_SECTIONS.length;

export function CheckupView({
    settings,
    locked
}: {
    settings: core.PrivacySettings;
    locked: readonly core.PrivacyField[];
}) {
    const t = useTranslations("accountPrivacy");
    const toast = useToast();
    const [step, setStep] = useState(0);
    const [draft, setDraft] = useState(settings);
    const [saved, setSaved] = useState(settings);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    const section = core.PRIVACY_SECTIONS[step];
    const fields = section ? (section.fields as readonly core.PrivacyField[]) : [];
    const open = fields.filter((field) => !locked.includes(field));
    const dirty = fields.some((field) => draft[field].audience !== saved[field].audience);

    const choose = (field: core.PrivacyField, audience: core.PrivacyAudience) =>
        setDraft((current) => ({
            ...current,
            // A recommendation never names people, so a list it replaces goes.
            [field]: { audience, listId: null, people: [] }
        }));

    const recommend = () => {
        for (const field of open) {
            if (draft[field].audience !== core.RECOMMENDED_PRIVACY[field]) {
                choose(field, core.RECOMMENDED_PRIVACY[field]);
            }
        }
    };

    const save = async () => {
        setSaving(true);
        setError("");
        const result = await runAction(() => savePrivacyAction(draft), setError);
        setSaving(false);
        if (!result || result.error) {
            if (result?.error) setError(result.error);
            return false;
        }
        setSaved(draft);
        toast.show({ key: "privacy-checkup", title: t("checkup.saved") });
        return true;
    };

    const next = async () => {
        if (dirty && !(await save())) return;
        setStep((current) => Math.min(current + 1, SECURITY_STEP));
    };

    return (
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
            <div className="flex min-w-0 items-center gap-2">
                <Button size="sm" variant="ghost" asChild>
                    <Link href="/account/privacy" aria-label={t("checkup.back")}>
                        <ArrowLeft className="size-4 shrink-0" />
                    </Link>
                </Button>
                <div className="min-w-0">
                    <h1 className="truncate text-[1.0625rem] font-semibold tracking-tight">
                        {t("checkup.title")}
                    </h1>
                    <p className="text-sm text-muted-foreground">
                        {t("checkup.progress", {
                            step: step + 1,
                            total: SECURITY_STEP + 1
                        })}
                    </p>
                </div>
            </div>

            <Card>
                <CardBody className="flex flex-col gap-3 p-3">
                    {section ? (
                        <>
                            <h2 className="text-sm font-medium">
                                {t(`sections.${section.id}` as const)}
                            </h2>
                            <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border">
                                {fields.map((field) => (
                                    <li
                                        key={field}
                                        className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2"
                                    >
                                        <span className="min-w-[12rem] flex-1">
                                            <span className="block text-[0.8125rem]">
                                                {t(`fields.${field}.label` as const)}
                                            </span>
                                            <span className="block text-[0.6875rem] leading-snug text-foreground-subtle">
                                                {locked.includes(field)
                                                    ? t("lockedByAdmin")
                                                    : t("checkup.recommended", {
                                                          audience: t(
                                                              `audiences.${core.RECOMMENDED_PRIVACY[field]}` as const
                                                          )
                                                      })}
                                            </span>
                                        </span>
                                        <Select
                                            className="h-8 w-full shrink-0 text-xs sm:w-64"
                                            aria-label={t(`fields.${field}.label` as const)}
                                            value={draft[field].audience}
                                            disabled={locked.includes(field) || saving}
                                            options={core
                                                .defaultAudiencesFor(field)
                                                .concat(
                                                    core.audienceNeedsList(draft[field].audience)
                                                        ? [draft[field].audience]
                                                        : []
                                                )
                                                .map((audience) => ({
                                                    value: audience,
                                                    label: t(`audiences.${audience}` as const)
                                                }))}
                                            onValueChange={(value) =>
                                                choose(field, value as core.PrivacyAudience)
                                            }
                                        />
                                    </li>
                                ))}
                            </ul>
                        </>
                    ) : (
                        <>
                            <h2 className="text-sm font-medium">{t("checkup.security.title")}</h2>
                            <p className="text-[0.8125rem] text-muted-foreground">
                                {t("checkup.security.intro")}
                            </p>
                            <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border">
                                {(
                                    [
                                        ["twoFactor", ShieldCheck, "/account/security/two-factor"],
                                        ["passkeys", KeyRound, "/account/security/passkeys"],
                                        ["sessions", MonitorSmartphone, "/account/sessions"]
                                    ] as const
                                ).map(([key, Icon, href]) => (
                                    <li
                                        key={key}
                                        className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2"
                                    >
                                        <Icon className="size-4 shrink-0 text-muted-foreground" />
                                        <span className="min-w-[12rem] flex-1">
                                            <span className="block text-[0.8125rem]">
                                                {t(`checkup.security.${key}.label` as const)}
                                            </span>
                                            <span className="block text-[0.6875rem] leading-snug text-foreground-subtle">
                                                {t(`checkup.security.${key}.hint` as const)}
                                            </span>
                                        </span>
                                        <Button size="sm" variant="secondary" asChild>
                                            <Link href={href}>{t("checkup.security.open")}</Link>
                                        </Button>
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}
                    {error && (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                        {section && open.length > 0 && (
                            <Button size="sm" variant="secondary" onClick={recommend} disabled={saving}>
                                {t("checkup.useRecommended")}
                            </Button>
                        )}
                        <span className="flex-1" />
                        {step > 0 && (
                            <Button
                                size="sm"
                                variant="ghost"
                                disabled={saving}
                                onClick={() => setStep((current) => current - 1)}
                            >
                                {t("checkup.previous")}
                            </Button>
                        )}
                        {section ? (
                            <Button size="sm" disabled={saving} onClick={() => void next()}>
                                {dirty ? t("checkup.saveAndContinue") : t("checkup.continue")}
                            </Button>
                        ) : (
                            <Button size="sm" asChild>
                                <Link href="/account/privacy">{t("checkup.finish")}</Link>
                            </Button>
                        )}
                    </div>
                </CardBody>
            </Card>
        </div>
    );
}
