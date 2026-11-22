"use client";

/**
 * A Telegram channel's bot profile: the name, descriptions and picture people
 * see on Telegram, read live from the bot and written back through it. The
 * channel's own name in Polaris is a separate label and is not touched here.
 *
 * Every field answers on its own - Telegram rate-limits name changes harder than
 * the rest, so one refusal must not hide that the others went through.
 */

import { useTranslations } from "@/components/i18n/i18n-provider";
import { Check, ExternalLink, Loader2, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState, useTransition } from "react";
import { Button, Input, Skeleton, Textarea, isDirty } from "@polaris/ui";
import type { BotProfile, BotProfileField } from "@/lib/messaging/telegram-bot-profile";
import { applyTelegramBotProfileAction, telegramBotProfileAction, type BotProfileFieldOutcome } from "./actions";

/** The Bot API's limits, mirrored for the inputs (the server checks them again). */
const LIMITS = { name: 64, description: 512, shortDescription: 120 } as const;

type TextField = keyof typeof LIMITS;
type Values = Record<TextField, string>;

function valuesOf(profile: BotProfile): Values {
    return { name: profile.name, description: profile.description, shortDescription: profile.shortDescription };
}

export function TelegramBotProfile({ channelId }: { channelId: string }) {
    const t = useTranslations("admin");
    const [profile, setProfile] = useState<BotProfile | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [values, setValues] = useState<Values | null>(null);
    const [outcomes, setOutcomes] = useState<Partial<Record<BotProfileField, BotProfileFieldOutcome>>>({});
    const [error, setError] = useState<string | null>(null);
    const [busy, startBusy] = useTransition();

    const load = useCallback(async () => {
        setLoadError(null);
        const result = await telegramBotProfileAction(channelId);
        if (result.error || !result.profile) return setLoadError(result.error ?? null);
        setProfile(result.profile);
        setValues(valuesOf(result.profile));
    }, [channelId]);

    useEffect(() => {
        void load();
    }, [load]);

    function apply(input: Record<string, unknown>) {
        setError(null);
        setOutcomes({});
        startBusy(async () => {
            const result = await applyTelegramBotProfileAction({ channelId, ...input });
            if (result.error) return setError(result.error);
            setOutcomes(Object.fromEntries((result.results ?? []).map((outcome) => [outcome.field, outcome])));
            if (result.profile) {
                setProfile(result.profile);
                // Keep what a refused field still holds, so it can be retried as typed.
                const failed = new Set((result.results ?? []).filter((r) => !r.ok).map((r) => r.field));
                const fresh = valuesOf(result.profile);
                setValues((current) =>
                    current
                        ? (Object.fromEntries(
                              (Object.keys(fresh) as TextField[]).map((field) => [
                                  field,
                                  failed.has(field) && input.mode === "custom" ? current[field] : fresh[field]
                              ])
                          ) as Values)
                        : fresh
                );
            }
        });
    }

    function saveCustom() {
        if (!profile || !values) return;
        const loaded = valuesOf(profile);
        const changed = (Object.keys(values) as TextField[]).filter((field) => values[field].trim() !== loaded[field]);
        apply({ mode: "custom", ...Object.fromEntries(changed.map((field) => [field, values[field].trim()])) });
    }

    const loaded = profile ? valuesOf(profile) : null;
    const trimmed = values
        ? { name: values.name.trim(), description: values.description.trim(), shortDescription: values.shortDescription.trim() }
        : null;
    const unchanged = !loaded || !trimmed || !isDirty(loaded, trimmed);
    const invalid = !trimmed || !trimmed.name;

    function status(field: BotProfileField) {
        const outcome = outcomes[field];
        if (!outcome) return null;
        return outcome.ok ? (
            <p className="flex items-center gap-1 text-xs text-success">
                <Check className="size-3.5 shrink-0" />
                {t("messaging.botProfile.updated")}
            </p>
        ) : (
            <p className="text-xs text-danger">{outcome.error}</p>
        );
    }

    function field(name: TextField, label: string, hint?: string) {
        const shared = {
            value: values?.[name] ?? "",
            maxLength: LIMITS[name],
            disabled: busy,
            onChange: (event: { target: { value: string } }) =>
                setValues((current) => (current ? { ...current, [name]: event.target.value } : current))
        };
        return (
            <label className="flex min-w-0 flex-col gap-1 text-sm">
                <span className="font-medium">{label}</span>
                {values ? (
                    name === "description" ? (
                        <Textarea rows={3} {...shared} />
                    ) : (
                        <Input {...shared} />
                    )
                ) : (
                    <Skeleton className={name === "description" ? "h-20 w-full" : "h-9 w-full"} />
                )}
                {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
                {status(name)}
            </label>
        );
    }

    return (
        <section className="flex flex-col gap-3 border-t border-border pt-4">
            <div className="flex min-w-0 flex-col gap-0.5">
                <h3 className="text-sm font-medium">{t("messaging.botProfile.title")}</h3>
                <p className="text-xs text-muted-foreground">{t("messaging.botProfile.description")}</p>
            </div>
            {loadError ? (
                <div className="flex flex-wrap items-center gap-2">
                    <p className="min-w-0 flex-1 text-sm text-danger">{loadError}</p>
                    <Button type="button" size="sm" variant="secondary" onClick={() => void load()}>
                        {t("messaging.botProfile.retry")}
                    </Button>
                </div>
            ) : (
                <>
                    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                        <dt className="text-muted-foreground">{t("messaging.botProfile.username")}</dt>
                        <dd className="min-w-0">
                            {profile ? (
                                profile.username ? (
                                    <a
                                        href={`https://t.me/${profile.username}`}
                                        target="_blank"
                                        rel="noreferrer noopener"
                                        className="inline-flex max-w-full items-center gap-1 text-primary hover:underline"
                                        title={`@${profile.username}`}
                                    >
                                        <span className="truncate">@{profile.username}</span>
                                        <ExternalLink className="size-3.5 shrink-0" />
                                    </a>
                                ) : (
                                    "-"
                                )
                            ) : (
                                <Skeleton className="h-4 w-32" />
                            )}
                        </dd>
                        <dt className="text-muted-foreground">{t("messaging.botProfile.picture")}</dt>
                        <dd className="min-w-0">
                            {profile ? (
                                profile.hasPhoto ? (
                                    t("messaging.botProfile.pictureSet")
                                ) : (
                                    t("messaging.botProfile.pictureNone")
                                )
                            ) : (
                                <Skeleton className="h-4 w-16" />
                            )}
                            {status("photo")}
                        </dd>
                    </dl>
                    {field("name", t("messaging.botProfile.name"))}
                    {field("description", t("messaging.botProfile.botDescription"), t("messaging.botProfile.descriptionHint"))}
                    {field(
                        "shortDescription",
                        t("messaging.botProfile.shortDescription"),
                        t("messaging.botProfile.shortDescriptionHint")
                    )}
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="flex flex-wrap items-center justify-end gap-2">
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={() => apply({ mode: "polaris" })}
                            disabled={busy || !profile}
                        >
                            {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                            {t("messaging.botProfile.usePolaris")}
                        </Button>
                        <Button type="button" onClick={saveCustom} disabled={busy || unchanged || invalid}>
                            {t("messaging.botProfile.save")}
                        </Button>
                    </div>
                    <p className="text-end text-xs text-muted-foreground">{t("messaging.botProfile.usePolarisHint")}</p>
                </>
            )}
        </section>
    );
}
