"use client";

/**
 * Which pull requests the repository bot reviews on its own, for one tier.
 *
 * Shared by every tier editor - the instance, a person's general and
 * organization tiers, and one repository - because they decide the same thing
 * and differ only in what an inherited value falls through to. Every field
 * offers "inherit" and names what that currently means.
 */

import * as core from "@polaris/core";
import { Button, Input, Select } from "@polaris/ui";
import { ListField } from "@/components/list-field";
import { useTranslations } from "@/components/i18n/i18n-provider";

const INHERIT = "__inherit__";

type ListKey = "baseBranches" | "labels" | "ignoreTitleKeywords" | "ignoreAuthors";

export function ReviewFields({
    value,
    inherited,
    onChange
}: {
    value: core.ReviewSettings;
    /** What every field resolves to when this tier says nothing. */
    inherited: core.ResolvedReview;
    onChange: (next: core.ReviewSettings) => void;
}) {
    const t = useTranslations("agents");
    const set = <K extends keyof core.ReviewSettings>(key: K, next: core.ReviewSettings[K]) =>
        onChange({ ...value, [key]: next });
    const onOff = (on: boolean) => (on ? t("settingsFields.on") : t("settingsFields.off"));
    const listSummary = (entries: readonly string[]) =>
        entries.length === 0 ? t("review.none") : entries.join(", ");

    const bool = (key: "drafts" | "incremental") => (
        <Select
            value={value[key] === null ? INHERIT : String(value[key])}
            onValueChange={(next) => set(key, next === INHERIT ? null : next === "true")}
            options={[
                { value: INHERIT, label: t("settingsFields.inherit", { value: onOff(inherited[key]) }) },
                { value: "true", label: t("settingsFields.on") },
                { value: "false", label: t("settingsFields.off") }
            ]}
        />
    );

    /** A list either inherits - shown read-only with a way to override - or is
     *  this tier's own, where emptying it is a deliberate "no narrowing". */
    const list = (key: ListKey, placeholder: string, caseInsensitive = true) => {
        const own = value[key];
        if (own === null)
            return (
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="min-w-0 truncate text-sm text-muted-foreground" title={listSummary(inherited[key])}>
                        {t("settingsFields.inherit", { value: listSummary(inherited[key]) })}
                    </span>
                    <Button type="button" size="sm" variant="outline" onClick={() => set(key, [...inherited[key]])}>
                        {t("review.override")}
                    </Button>
                </div>
            );
        return (
            <div className="flex min-w-0 flex-col gap-1">
                <ListField
                    value={own}
                    onChange={(next) => set(key, next)}
                    placeholder={placeholder}
                    max={core.REVIEW_LIST_MAX}
                    caseInsensitive={caseInsensitive}
                />
                <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="self-start"
                    onClick={() => set(key, null)}
                >
                    {t("review.useInherited")}
                </Button>
            </div>
        );
    };

    return (
        <div className="flex min-w-0 flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label={t("review.drafts")} hint={t("review.draftsHint")}>
                    {bool("drafts")}
                </Field>
                <Field label={t("review.incremental")} hint={t("review.incrementalHint")}>
                    {bool("incremental")}
                </Field>
                <Field label={t("review.pauseAfter")} hint={t("review.pauseAfterHint")}>
                    <PauseAfter
                        value={value.pauseAfter}
                        inherited={inherited.pauseAfter}
                        onChange={(next) => set("pauseAfter", next)}
                    />
                </Field>
                <Field
                    label={t("review.source")}
                    hint={t(`review.sourceNotes.${value.configSource ?? inherited.configSource}`, {
                        path: core.REVIEW_CONFIG_PATH
                    })}
                >
                    <Select
                        value={value.configSource ?? INHERIT}
                        onValueChange={(next) =>
                            set("configSource", next === INHERIT ? null : (next as core.ReviewConfigSource))
                        }
                        options={[
                            {
                                value: INHERIT,
                                label: t("settingsFields.inherit", {
                                    value: t(`review.sources.${inherited.configSource}`)
                                })
                            },
                            ...core.REVIEW_CONFIG_SOURCES.map((source) => ({
                                value: source,
                                label: t(`review.sources.${source}`)
                            }))
                        ]}
                    />
                </Field>
            </div>
            <Field label={t("review.baseBranches")} hint={t("review.baseBranchesHint")}>
                {list("baseBranches", t("review.baseBranchesPlaceholder"), false)}
            </Field>
            <Field label={t("review.labels")} hint={t("review.labelsHint")}>
                {list("labels", t("review.labelsPlaceholder"))}
            </Field>
            <Field label={t("review.ignoreTitleKeywords")} hint={t("review.ignoreTitleKeywordsHint")}>
                {list("ignoreTitleKeywords", t("review.ignoreTitleKeywordsPlaceholder"))}
            </Field>
            <Field label={t("review.ignoreAuthors")} hint={t("review.ignoreAuthorsHint")}>
                {list("ignoreAuthors", t("review.ignoreAuthorsPlaceholder"))}
            </Field>
        </div>
    );
}

/** A number of pushes, or inherit. Kept as text while typed so clearing the
 *  field to type a new number does not snap it back. */
function PauseAfter({
    value,
    inherited,
    onChange
}: {
    value: number | null;
    inherited: number;
    onChange: (next: number | null) => void;
}) {
    const t = useTranslations("agents");
    return (
        <Input
            type="number"
            inputMode="numeric"
            min={0}
            max={core.REVIEW_PAUSE_MAX}
            value={value === null ? "" : String(value)}
            placeholder={t("settingsFields.inherit", { value: String(inherited) })}
            onChange={(event) => {
                const raw = event.target.value.trim();
                if (raw === "") return onChange(null);
                const number = Math.trunc(Number(raw));
                if (Number.isFinite(number)) onChange(Math.min(core.REVIEW_PAUSE_MAX, Math.max(0, number)));
            }}
        />
    );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
    return (
        <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium">{label}</p>
            {children}
            {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
        </div>
    );
}
