"use client";

/**
 * What a review says, for one tier: how hard it pushes, the extras it adds,
 * the pre-merge checks it runs, per-path instructions and the named jobs
 * people can ask for. Every field inherits until this tier sets it, and the
 * inherited option names what that means.
 */

import * as core from "@polaris/core";
import { Plus, Trash2 } from "lucide-react";
import { CountField, Field } from "@/components/agents/review-fields";
import { Button, Input, ListField, Select, Textarea } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";

const INHERIT = "__inherit__";

type BoolKey =
    | "describePr"
    | "walkthrough"
    | "collapseWalkthrough"
    | "changedFiles"
    | "sequenceDiagrams"
    | "effortEstimate"
    | "linkedIssues"
    | "suggestLabels"
    | "applyLabels"
    | "suggestReviewers"
    | "scanners"
    | "webSearch";

type CheckKey = "titleCheck" | "descriptionCheck" | "issueCheck" | "docstringCheck";

const BOOLS: readonly BoolKey[] = [
    "describePr",
    "walkthrough",
    "collapseWalkthrough",
    "changedFiles",
    "sequenceDiagrams",
    "effortEstimate",
    "linkedIssues",
    "suggestLabels",
    "applyLabels",
    "suggestReviewers",
    "scanners"
];
const CHECKS: readonly CheckKey[] = ["titleCheck", "descriptionCheck", "issueCheck", "docstringCheck"];

/** A row of one of the object lists, whatever its first field is called. */
interface Entry {
    key: string;
    instructions: string;
    level?: core.ReviewCheckLevel;
}

export function ReviewOutputFields({
    value,
    inherited,
    onChange
}: {
    value: core.ReviewSettings;
    inherited: core.ResolvedReview;
    onChange: (next: core.ReviewSettings) => void;
}) {
    const t = useTranslations("agents");
    const set = <K extends keyof core.ReviewSettings>(key: K, next: core.ReviewSettings[K]) =>
        onChange({ ...value, [key]: next });
    const onOff = (on: boolean) => (on ? t("settingsFields.on") : t("settingsFields.off"));

    const bool = (key: BoolKey) => (
        <Field key={key} label={t(`reviewOutput.bools.${key}`)}>
            <Select
                value={value[key] === null ? INHERIT : String(value[key])}
                onValueChange={(next) => set(key, next === INHERIT ? null : next === "true")}
                options={[
                    { value: INHERIT, label: t("settingsFields.inherit", { value: onOff(inherited[key]) }) },
                    { value: "true", label: t("settingsFields.on") },
                    { value: "false", label: t("settingsFields.off") }
                ]}
            />
        </Field>
    );

    const check = (key: CheckKey) => (
        <Field key={key} label={t(`reviewOutput.checks.${key}`)}>
            <Select
                value={value[key] ?? INHERIT}
                onValueChange={(next) => set(key, next === INHERIT ? null : (next as core.ReviewCheckLevel))}
                options={[
                    {
                        value: INHERIT,
                        label: t("settingsFields.inherit", { value: t(`reviewOutput.levels.${inherited[key]}`) })
                    },
                    ...core.REVIEW_CHECK_LEVELS.map((level) => ({
                        value: level,
                        label: t(`reviewOutput.levels.${level}`)
                    }))
                ]}
            />
        </Field>
    );

    /** Inherit, or this tier's own copy, for any of the list fields. */
    const own = <T,>(
        current: T[] | null,
        fallback: readonly T[],
        render: (rows: T[]) => React.ReactNode,
        key: "pathFilters" | "customChecks" | "pathInstructions" | "recipes" | "guidelineFiles" | "linkedRepos"
    ) =>
        current === null ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="min-w-0 truncate text-sm text-muted-foreground">
                    {t("settingsFields.inherit", {
                        value: fallback.length === 0 ? t("review.none") : t("reviewOutput.count", { count: fallback.length })
                    })}
                </span>
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => set(key, [...fallback] as never)}
                >
                    {t("review.override")}
                </Button>
            </div>
        ) : (
            <div className="flex min-w-0 flex-col gap-2">
                {render(current)}
                <Button type="button" size="sm" variant="ghost" className="self-start" onClick={() => set(key, null)}>
                    {t("review.useInherited")}
                </Button>
            </div>
        );

    return (
        <div className="flex min-w-0 flex-col gap-4">
            <div className="min-w-0 border-t border-border pt-4">
                <p className="text-sm font-medium">{t("reviewOutput.title")}</p>
                <p className="text-xs text-muted-foreground">{t("reviewOutput.intro")}</p>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label={t("reviewOutput.profile")} hint={t(`reviewOutput.profileNotes.${value.profile ?? inherited.profile}`)}>
                    <Select
                        value={value.profile ?? INHERIT}
                        onValueChange={(next) => set("profile", next === INHERIT ? null : (next as core.ReviewProfile))}
                        options={[
                            {
                                value: INHERIT,
                                label: t("settingsFields.inherit", { value: t(`reviewOutput.profiles.${inherited.profile}`) })
                            },
                            ...core.REVIEW_PROFILES.map((profile) => ({
                                value: profile,
                                label: t(`reviewOutput.profiles.${profile}`)
                            }))
                        ]}
                    />
                </Field>
                {BOOLS.map(bool)}
            </div>
            <Field label={t("reviewOutput.tone")} hint={t("reviewOutput.toneHint")}>
                <Textarea
                    rows={2}
                    maxLength={core.REVIEW_PROSE_MAX}
                    value={value.tone ?? ""}
                    placeholder={inherited.tone || t("reviewOutput.tonePlaceholder")}
                    onChange={(event) => set("tone", event.target.value === "" ? null : event.target.value)}
                />
            </Field>

            <div className="min-w-0">
                <p className="text-sm font-medium">{t("reviewOutput.checksTitle")}</p>
                <p className="text-xs text-muted-foreground">{t("reviewOutput.checksIntro")}</p>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {CHECKS.map(check)}
                <Field label={t("reviewOutput.docstringThreshold")} hint={t("reviewOutput.docstringThresholdHint")}>
                    <CountField
                        value={value.docstringThreshold}
                        inherited={inherited.docstringThreshold}
                        max={100}
                        onChange={(next) => set("docstringThreshold", next)}
                    />
                </Field>
            </div>
            <Field label={t("reviewOutput.customChecks")} hint={t("reviewOutput.customChecksHint")}>
                {own(
                    value.customChecks,
                    inherited.customChecks,
                    (rows) => (
                        <EntryList
                            rows={rows.map((row) => ({ key: row.name, instructions: row.instructions, level: row.level }))}
                            keyLabel={t("reviewOutput.checkName")}
                            withLevel
                            onChange={(next) =>
                                set(
                                    "customChecks",
                                    next.map((row) => ({ name: row.key, instructions: row.instructions, level: row.level ?? "warning" }))
                                )
                            }
                        />
                    ),
                    "customChecks"
                )}
            </Field>

            <Field label={t("reviewOutput.pathFilters")} hint={t("reviewOutput.pathFiltersHint")}>
                {own(
                    value.pathFilters,
                    inherited.pathFilters,
                    (rows) => (
                        <ListField
                            value={rows}
                            onChange={(next) => set("pathFilters", next)}
                            placeholder="dist/**, *.lock"
                            max={core.REVIEW_LIST_MAX}
                        />
                    ),
                    "pathFilters"
                )}
            </Field>
            <Field label={t("reviewOutput.pathInstructions")} hint={t("reviewOutput.pathInstructionsHint")}>
                {own(
                    value.pathInstructions,
                    inherited.pathInstructions,
                    (rows) => (
                        <EntryList
                            rows={rows.map((row) => ({ key: row.path, instructions: row.instructions }))}
                            keyLabel={t("reviewOutput.path")}
                            onChange={(next) =>
                                set("pathInstructions", next.map((row) => ({ path: row.key, instructions: row.instructions })))
                            }
                        />
                    ),
                    "pathInstructions"
                )}
            </Field>
            <Field label={t("reviewOutput.recipes")} hint={t("reviewOutput.recipesHint")}>
                {own(
                    value.recipes,
                    inherited.recipes,
                    (rows) => (
                        <EntryList
                            rows={rows.map((row) => ({ key: row.name, instructions: row.instructions }))}
                            keyLabel={t("reviewOutput.recipeName")}
                            onChange={(next) =>
                                set("recipes", next.map((row) => ({ name: row.key, instructions: row.instructions })))
                            }
                        />
                    ),
                    "recipes"
                )}
            </Field>

            <div className="min-w-0">
                <p className="text-sm font-medium">{t("reviewOutput.knowledgeTitle")}</p>
                <p className="text-xs text-muted-foreground">{t("reviewOutput.knowledgeIntro")}</p>
            </div>
            <Field label={t("reviewOutput.guidelineFiles")} hint={t("reviewOutput.guidelineFilesHint")}>
                {own(
                    value.guidelineFiles,
                    inherited.guidelineFiles,
                    (rows) => (
                        <ListField
                            value={rows}
                            onChange={(next) => set("guidelineFiles", next)}
                            placeholder="AGENTS.md, docs/style/**"
                            max={core.REVIEW_LIST_MAX}
                        />
                    ),
                    "guidelineFiles"
                )}
            </Field>
            <Field label={t("reviewOutput.linkedRepos")} hint={t("reviewOutput.linkedReposHint")}>
                {own(
                    value.linkedRepos,
                    inherited.linkedRepos,
                    (rows) => (
                        <ListField
                            value={rows}
                            onChange={(next) => set("linkedRepos", next)}
                            placeholder="shared-types, design-system"
                            max={core.REVIEW_LIST_MAX}
                            caseInsensitive
                        />
                    ),
                    "linkedRepos"
                )}
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{bool("webSearch")}</div>
        </div>
    );
}

/**
 * Rows of a name (or path) and its instructions, optionally with a level.
 * A row with either half empty is kept while it is typed but dropped on save,
 * and says so, so nobody is surprised it is gone.
 */
function EntryList({
    rows,
    keyLabel,
    withLevel = false,
    onChange
}: {
    rows: Entry[];
    keyLabel: string;
    withLevel?: boolean;
    onChange: (next: Entry[]) => void;
}) {
    const t = useTranslations("agents");
    const update = (index: number, patch: Partial<Entry>) =>
        onChange(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
    return (
        <div className="flex min-w-0 flex-col gap-3">
            {rows.map((row, index) => (
                <div key={index} className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-2">
                    <div className="flex min-w-0 items-center gap-2">
                        <Input
                            className="min-w-0 flex-1"
                            aria-label={keyLabel}
                            placeholder={keyLabel}
                            maxLength={100}
                            value={row.key}
                            onChange={(event) => update(index, { key: event.target.value })}
                        />
                        {withLevel ? (
                            <Select
                                value={row.level ?? "warning"}
                                onValueChange={(next) => update(index, { level: next as core.ReviewCheckLevel })}
                                options={core.REVIEW_CHECK_LEVELS.map((level) => ({
                                    value: level,
                                    label: t(`reviewOutput.levels.${level}`)
                                }))}
                            />
                        ) : null}
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={t("reviewOutput.removeEntry", { name: row.key || keyLabel })}
                            onClick={() => onChange(rows.filter((_, at) => at !== index))}
                        >
                            <Trash2 className="size-4 shrink-0" aria-hidden />
                        </Button>
                    </div>
                    <Textarea
                        rows={2}
                        aria-label={t("reviewOutput.instructions")}
                        placeholder={t("reviewOutput.instructions")}
                        maxLength={core.REVIEW_PROSE_MAX}
                        value={row.instructions}
                        onChange={(event) => update(index, { instructions: event.target.value })}
                    />
                    {(row.key.trim() === "") !== (row.instructions.trim() === "") ? (
                        <p className="text-xs text-warning">{t("reviewOutput.incomplete")}</p>
                    ) : null}
                </div>
            ))}
            <Button
                type="button"
                size="sm"
                variant="outline"
                className="self-start"
                disabled={rows.length >= core.REVIEW_LIST_MAX}
                onClick={() => onChange([...rows, { key: "", instructions: "", ...(withLevel ? { level: "warning" as const } : {}) }])}
            >
                <Plus className="size-3.5 shrink-0" aria-hidden />
                {t("reviewOutput.add")}
            </Button>
        </div>
    );
}
