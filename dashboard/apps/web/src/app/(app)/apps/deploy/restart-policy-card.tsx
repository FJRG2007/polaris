"use client";

/**
 * What happens when a service's container exits: never start it again, start it
 * again only when it fails - up to a number of times - or always. The next deploy
 * applies it.
 */

import { Input, Select } from "@polaris/ui";
import { useEffect, useState, useTransition } from "react";
import type { RestartPolicy } from "@polaris/deploy";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { CardError, CardSkeleton, SaveBar, SettingsCard, useSavedFlash } from "./settings-kit";
import { restartPolicyAction, setRestartPolicyAction } from "./deploy-behaviour-actions";
import { MAX_RESTART_RETRIES, RESTART_POLICIES, restartPolicySchema } from "@/lib/deploy/restart-policy-schema";

interface Draft {
    readonly policy: RestartPolicy["policy"];
    readonly retries: string;
}

function draftOf(policy: RestartPolicy): Draft {
    return { policy: policy.policy, retries: String(policy.maxRetries) };
}

export function RestartPolicyCard({
    applicationId,
    canConfigure
}: {
    applicationId: string;
    canConfigure: boolean;
}) {
    const t = useTranslations("deployService");
    const [saved, setSaved] = useState<RestartPolicy | null>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [justSaved, markSaved] = useSavedFlash();

    const load = () => {
        setLoadError(null);
        void restartPolicyAction(applicationId).then((result) => {
            if (result.error || !result.policy) return setLoadError(result.error ?? "");
            setSaved(result.policy);
            setDraft(draftOf(result.policy));
        });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(load, [applicationId]);

    if (loadError !== null)
        return (
            <CardError entry="restartPolicy" title={t("restart.title")} message={loadError} onRetry={load} />
        );
    if (!saved || !draft) return <CardSkeleton entry="restartPolicy" title={t("restart.title")} rows={1} />;

    const next = {
        policy: draft.policy,
        maxRetries: draft.policy === "on-failure" ? Number(draft.retries) : saved.maxRetries
    };
    const valid = restartPolicySchema.safeParse(next).success;
    const dirty = next.policy !== saved.policy || next.maxRetries !== saved.maxRetries;

    const save = () =>
        startTransition(async () => {
            setError(null);
            const result = await setRestartPolicyAction(applicationId, next);
            if (result.error) return setError(result.error);
            setSaved(next);
            setDraft(draftOf(next));
            markSaved();
        });

    return (
        <SettingsCard
            entry="restartPolicy"
            title={t("restart.title")}
            description={t(`restart.hint.${draft.policy}`)}
        >
            <div className="flex flex-wrap items-end gap-3">
                <div className="flex min-w-0 flex-1 flex-col gap-1 sm:max-w-xs">
                    <span className="text-xs font-medium">{t("restart.policy")}</span>
                    <Select
                        value={draft.policy}
                        disabled={!canConfigure}
                        onValueChange={(value) =>
                            setDraft({ ...draft, policy: value as RestartPolicy["policy"] })
                        }
                        options={RESTART_POLICIES.map((value) => ({
                            value,
                            label: t(`restart.option.${value}`)
                        }))}
                        aria-label={t("restart.policy")}
                    />
                </div>
                {draft.policy === "on-failure" && (
                    <label className="flex w-32 flex-col gap-1">
                        <span className="text-xs font-medium">{t("restart.maxRetries")}</span>
                        <Input
                            inputMode="numeric"
                            value={draft.retries}
                            disabled={!canConfigure}
                            onChange={(event) =>
                                setDraft({ ...draft, retries: event.target.value.replace(/\D/g, "") })
                            }
                            aria-invalid={!valid}
                        />
                    </label>
                )}
            </div>
            {canConfigure && (
                <SaveBar
                    dirty={dirty}
                    pending={pending}
                    justSaved={justSaved}
                    invalid={valid ? null : t("restart.retriesInvalid", { max: MAX_RESTART_RETRIES })}
                    error={error}
                    onSave={save}
                    onDiscard={() => setDraft(draftOf(saved))}
                />
            )}
        </SettingsCard>
    );
}
