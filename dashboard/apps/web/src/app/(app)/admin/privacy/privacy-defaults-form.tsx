"use client";

/**
 * What every privacy setting starts on, for the accounts that never chose it.
 *
 * Existing accounts included: a field somebody never touched is stored as "not
 * chosen" and follows this, so changing it here reaches them too. A field
 * somebody set keeps what they set. Grouped and worded exactly as the account's
 * own privacy screen is, so the two read as one setting seen from two sides.
 */

import * as core from "@polaris/core";
import { useState, useTransition } from "react";
import { Card, CardBody, Select, Switch } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { setPrivacyDefaultAction, setPrivacyLockAction } from "./actions";

type Defaults = Record<core.PrivacyField, core.PrivacyAudience>;

export function PrivacyDefaultsForm({
    defaults,
    locks = []
}: {
    defaults: Defaults;
    /** Fields held to their default for every account. */
    locks?: readonly core.PrivacyField[];
}) {
    const t = useTranslations("admin");
    const tp = useTranslations("accountPrivacy");
    const [values, setValues] = useState<Defaults>(defaults);
    const [locked, setLocked] = useState<ReadonlySet<core.PrivacyField>>(() => new Set(locks));

    // The same optimistic flip as an audience: shown at once, put back on refusal.
    const flipLock = (field: core.PrivacyField) => {
        const before = locked.has(field);
        const apply = (on: boolean) =>
            setLocked((current) => {
                const next = new Set(current);
                if (on) next.add(field);
                else next.delete(field);
                return next;
            });
        apply(!before);
        setError(null);
        setBusy(field);
        startTransition(async () => {
            const result = await setPrivacyLockAction(field, !before).catch(() => ({
                error: t("privacy.errors.checkSettings")
            }));
            if (result.error) {
                apply(before);
                setError(result.error);
            }
            setBusy(null);
        });
    };
    const [busy, setBusy] = useState<core.PrivacyField | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [, startTransition] = useTransition();

    // Shown at once and put back if the server refuses it.
    const choose = (field: core.PrivacyField, next: core.PrivacyAudience) => {
        const before = values[field];
        if (next === before) return;
        setValues((current) => ({ ...current, [field]: next }));
        setError(null);
        setBusy(field);
        startTransition(async () => {
            const result = await setPrivacyDefaultAction(field, next).catch(() => ({
                error: t("privacy.errors.audience")
            }));
            if (result.error) {
                setValues((current) => ({ ...current, [field]: before }));
                setError(result.error);
            }
            setBusy(null);
        });
    };

    return (
        <Card>
            <CardBody className="flex flex-col gap-4 p-3">
                {core.PRIVACY_SECTIONS.map((section) => (
                    <section key={section.id} className="flex flex-col gap-1.5">
                        <h3 className="text-[0.6875rem] font-medium uppercase tracking-[0.04em] text-foreground-subtle">
                            {tp(`sections.${section.id}` as const)}
                        </h3>
                        <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border">
                            {section.fields.map((field) => (
                                <li
                                    key={field}
                                    className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2"
                                >
                                    <span className="min-w-0 flex-1 text-[0.8125rem] sm:min-w-[12rem]">
                                        {tp(`fields.${field}.label` as const)}
                                    </span>
                                    <Select
                                        className="h-8 w-full shrink-0 text-xs sm:w-64"
                                        aria-label={tp(`fields.${field}.label` as const)}
                                        value={values[field]}
                                        disabled={busy === field}
                                        options={core.defaultAudiencesFor(field).map((audience) => ({
                                            value: audience,
                                            label: tp(`audiences.${audience}` as const)
                                        }))}
                                        onValueChange={(value) =>
                                            choose(field, value as core.PrivacyAudience)
                                        }
                                    />
                                    <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                                        <Switch
                                            checked={locked.has(field)}
                                            disabled={busy === field}
                                            aria-label={t("privacy.defaults.lockLabel", {
                                                field: tp(`fields.${field}.label` as const)
                                            })}
                                            onChange={() => flipLock(field)}
                                        />
                                        {t("privacy.defaults.lock")}
                                    </label>
                                </li>
                            ))}
                        </ul>
                    </section>
                ))}
                {error ? (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                ) : null}
            </CardBody>
        </Card>
    );
}
