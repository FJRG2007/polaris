"use client";

/**
 * The operator's Calendar settings for everybody: subscriptions by address,
 * booking pages, and the public calendars suggested in the subscribe dialog.
 * Read in the browser so the page frame is on screen first; saved as a whole,
 * and only when something actually changed.
 */

import { useCalendarT } from "../i18n";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button, Input, Skeleton, Switch } from "@polaris/ui";
import { addressSchema, nameSchema } from "../../lib/schemas";
import type { InstanceSettings } from "../../lib/instance-settings";
import { loadInstanceSettingsAction, saveInstanceSettingsAction } from "../../actions/instance";

type Draft = InstanceSettings;

function same(left: Draft, right: Draft): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

export function InstanceView() {
    const t = useCalendarT();
    const [saved, setSaved] = useState<Draft | null>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [canManage, setCanManage] = useState(false);
    const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<string | null>(null);

    useEffect(() => {
        let live = true;
        void loadInstanceSettingsAction().then((result) => {
            if (!live) return;
            if (!result.ok) {
                setState("failed");
                setMessage(result.error);
                return;
            }
            setSaved(result.settings);
            setDraft(result.settings);
            setCanManage(result.canManage);
            setState("ready");
        });
        return () => {
            live = false;
        };
    }, []);

    const problems = useMemo(
        () =>
            (draft?.suggested ?? []).map((entry) => ({
                name: entry.name.trim() !== "" && !nameSchema.safeParse(entry.name).success,
                url: entry.url.trim() !== "" && !addressSchema.safeParse(entry.url).success,
                incomplete: entry.name.trim() === "" || entry.url.trim() === ""
            })),
        [draft]
    );
    const invalid = problems.some((problem) => problem.name || problem.url || problem.incomplete);
    const dirty = draft !== null && saved !== null && !same(draft, saved);
    const blocked = !canManage || !dirty || invalid || saving;
    const reason = !canManage
        ? t("instancePage.adminOnly")
        : !dirty
          ? t("instancePage.noChanges")
          : invalid
            ? t("instancePage.fixSuggested")
            : undefined;

    async function save() {
        if (blocked || !draft) return;
        setSaving(true);
        setMessage(null);
        const result = await saveInstanceSettingsAction({
            ...draft,
            suggested: draft.suggested.map((entry) => ({ name: entry.name.trim(), url: entry.url.trim() }))
        });
        setSaving(false);
        if (!result.ok) {
            setMessage(result.error);
            return;
        }
        setSaved(result.settings);
        setDraft(result.settings);
        setMessage(t("instancePage.saved"));
    }

    if (state === "failed") return <p className="text-sm text-danger">{message}</p>;

    return (
        <div className="flex flex-col gap-6">
            <section className="flex flex-col gap-3">
                {draft === null ? (
                    <Skeleton className="h-16 w-full" />
                ) : (
                    <>
                        <label className="flex items-start justify-between gap-4">
                            <span className="flex min-w-0 flex-col">
                                <span className="text-sm font-medium">{t("instancePage.subscriptions")}</span>
                                <span className="text-xs text-muted-foreground">{t("instancePage.subscriptionsHint")}</span>
                            </span>
                            <Switch
                                checked={draft.allowSubscriptions}
                                disabled={!canManage}
                                onChange={(value: boolean) => setDraft({ ...draft, allowSubscriptions: value })}
                                aria-label={t("instancePage.subscriptions")}
                            />
                        </label>
                        <label className="flex items-start justify-between gap-4">
                            <span className="flex min-w-0 flex-col">
                                <span className="text-sm font-medium">{t("instancePage.booking")}</span>
                                <span className="text-xs text-muted-foreground">{t("instancePage.bookingHint")}</span>
                            </span>
                            <Switch
                                checked={draft.allowBooking}
                                disabled={!canManage}
                                onChange={(value: boolean) => setDraft({ ...draft, allowBooking: value })}
                                aria-label={t("instancePage.booking")}
                            />
                        </label>
                    </>
                )}
            </section>

            <section className="flex flex-col gap-2">
                <h2 className="text-sm font-semibold">{t("instancePage.suggested")}</h2>
                <p className="text-xs text-muted-foreground">{t("instancePage.suggestedHint")}</p>
                {draft === null ? (
                    <Skeleton className="h-10 w-full" />
                ) : (
                    <ul className="flex flex-col gap-2">
                        {draft.suggested.map((entry, index) => (
                            <li key={index} className="flex flex-col gap-2 sm:flex-row sm:items-start">
                                <div className="flex min-w-0 flex-1 flex-col gap-1">
                                    <Input
                                        value={entry.name}
                                        disabled={!canManage}
                                        placeholder={t("instancePage.namePlaceholder")}
                                        aria-label={t("instancePage.name")}
                                        aria-invalid={problems[index]?.name || undefined}
                                        onChange={(event) => {
                                            const suggested = [...draft.suggested];
                                            suggested[index] = { ...entry, name: event.target.value };
                                            setDraft({ ...draft, suggested });
                                        }}
                                    />
                                    {problems[index]?.name ? (
                                        <span className="text-xs text-danger">{t("instancePage.nameInvalid")}</span>
                                    ) : null}
                                </div>
                                <div className="flex min-w-0 flex-[2] flex-col gap-1">
                                    <Input
                                        value={entry.url}
                                        disabled={!canManage}
                                        inputMode="url"
                                        autoCapitalize="none"
                                        autoCorrect="off"
                                        spellCheck={false}
                                        placeholder="https://"
                                        aria-label={t("instancePage.address")}
                                        aria-invalid={problems[index]?.url || undefined}
                                        onChange={(event) => {
                                            const suggested = [...draft.suggested];
                                            suggested[index] = { ...entry, url: event.target.value };
                                            setDraft({ ...draft, suggested });
                                        }}
                                    />
                                    {problems[index]?.url ? (
                                        <span className="text-xs text-danger">{t("instancePage.addressInvalid")}</span>
                                    ) : null}
                                </div>
                                <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    className="shrink-0"
                                    disabled={!canManage}
                                    aria-label={t("instancePage.removeNamed", { name: entry.name || entry.url })}
                                    title={t("instancePage.remove")}
                                    onClick={() =>
                                        setDraft({
                                            ...draft,
                                            suggested: draft.suggested.filter((_, at) => at !== index)
                                        })
                                    }
                                >
                                    <Trash2 aria-hidden="true" className="size-4 shrink-0" />
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}
                {draft !== null && canManage && draft.suggested.length < 20 ? (
                    <div>
                        <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => setDraft({ ...draft, suggested: [...draft.suggested, { name: "", url: "" }] })}
                        >
                            <Plus aria-hidden="true" className="size-4 shrink-0" />
                            {t("instancePage.add")}
                        </Button>
                    </div>
                ) : null}
            </section>

            <div className="flex items-center gap-3">
                <Button
                    type="button"
                    aria-disabled={blocked || undefined}
                    title={reason}
                    className={blocked ? "opacity-60" : undefined}
                    onClick={() => void save()}
                >
                    {t("instancePage.save")}
                </Button>
                <span aria-live="polite" className="text-sm text-muted-foreground">
                    {message}
                </span>
            </div>
        </div>
    );
}
