"use client";

/**
 * The Writing page of Polar's settings: what "Improve" writes with, wherever
 * it appears (mail, tasks, the composers).
 *
 * - The model. Rewriting a paragraph needs no clever model, so it defaults to
 *   the one Polar's small jobs use, and a person can pick a cheaper one or a
 *   better writer.
 * - The writer's own context (their role, how they sign, their tone) and the
 *   skills a rewrite follows, such as a style guide or a product sheet.
 * - Each organization's shared guide: what the company does and how it
 *   writes. Every member's rewrites follow it when the text belongs to the
 *   organization; whoever manages its settings edits it here.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { isAutomatic, type ModelChoice } from "@/lib/polar/shared";
import { useSettingsModels } from "@/components/polar/settings-models";
import { ModelSelector } from "@/components/polar/elements/model-selector";
import { Badge, Button, Skeleton, Textarea, cn, useToast } from "@polaris/ui";
import { helperAvailable, helperChoiceOf } from "@/components/polar/polar-helper-settings";
import {
    helperModelOf,
    WRITING_CONTEXT_MAX,
    WRITING_SKILLS_MAX,
    type PolarHelperModel
} from "@/lib/polar/display";
import {
    orgWritingGuidesAction,
    saveOrgWritingGuideAction,
    type OrgWritingGuide
} from "@/app/(app)/polar/settings/writing-actions";

interface Writing {
    improveModel: PolarHelperModel | null;
    writingContext: string;
    writingSkills: string[];
}

async function savePreferences(patch: Partial<Writing>): Promise<Writing | null> {
    const response = await fetch("/api/polar/preferences", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch)
    }).catch(() => null);
    if (!response?.ok) return null;
    return readWriting(await response.json().catch(() => null));
}

function readWriting(data: unknown): Writing {
    const row = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    return {
        improveModel: helperModelOf(row.improveModel),
        writingContext: typeof row.writingContext === "string" ? row.writingContext : "",
        writingSkills: Array.isArray(row.writingSkills)
            ? row.writingSkills.filter((name): name is string => typeof name === "string")
            : []
    };
}

export function PolarWritingSettings({
    skills,
    readOnly
}: {
    /** The names of this person's enabled skills. */
    skills: readonly string[];
    readOnly: boolean;
}) {
    const t = useTranslations("polar");
    const toast = useToast();
    const { answer } = useSettingsModels();
    const providers = answer?.providers ?? null;
    // Undefined until read: nothing is shown as chosen before it is known.
    const [writing, setWriting] = useState<Writing | undefined>(undefined);
    const [context, setContext] = useState("");
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        let live = true;
        void fetch("/api/polar/preferences")
            .then((response) => (response.ok ? response.json() : null))
            .then((data: unknown) => {
                if (!live) return;
                const read = readWriting(data);
                setWriting(read);
                setContext(read.writingContext);
            })
            .catch(() => {
                if (live) setWriting(readWriting(null));
            });
        return () => {
            live = false;
        };
    }, []);

    const failed = () => toast.show({ title: t("settings.writing.failed") });

    /** Shown at once, put back when the server did not keep it. */
    async function change(patch: Partial<Writing>) {
        if (!writing) return;
        const before = writing;
        setWriting({ ...writing, ...patch });
        const saved = await savePreferences(patch);
        if (!saved) {
            setWriting(before);
            failed();
            return;
        }
        setWriting(saved);
    }

    function pick(choice: ModelChoice) {
        const next: PolarHelperModel | null = isAutomatic(choice)
            ? null
            : { provider: choice.provider, model: choice.model, payer: choice.payer };
        if (JSON.stringify(writing?.improveModel ?? null) === JSON.stringify(next)) return;
        void change({ improveModel: next });
    }

    function toggleSkill(name: string) {
        if (!writing) return;
        const on = writing.writingSkills.includes(name);
        if (!on && writing.writingSkills.length >= WRITING_SKILLS_MAX) return;
        void change({
            writingSkills: on
                ? writing.writingSkills.filter((entry) => entry !== name)
                : [...writing.writingSkills, name]
        });
    }

    const contextDirty = writing !== undefined && context.trim() !== writing.writingContext.trim();
    async function saveContext() {
        if (!contextDirty || saving) return;
        setSaving(true);
        await change({ writingContext: context.trim() });
        setSaving(false);
    }

    const available = helperAvailable(writing?.improveModel ?? null, providers);
    const full = (writing?.writingSkills.length ?? 0) >= WRITING_SKILLS_MAX;

    return (
        <div className="flex flex-col gap-6">
            <section className="flex flex-col gap-2">
                <div className="min-w-0">
                    <h2 className="text-sm font-medium text-foreground">
                        {t("settings.writing.title")}
                    </h2>
                    <p className="text-xs text-muted-foreground">{t("settings.writing.intro")}</p>
                </div>
                <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                    <li className="flex min-w-0 flex-wrap items-center gap-3 px-3 py-2">
                        <div className="min-w-0 flex-1">
                            <p className="text-sm text-foreground">{t("settings.writing.model")}</p>
                            <p
                                className={cn(
                                    "text-xs",
                                    available ? "text-muted-foreground" : "text-warning"
                                )}
                                role={available ? undefined : "status"}
                            >
                                {available
                                    ? t("settings.writing.modelHint")
                                    : t("settings.helper.unavailable")}
                            </p>
                        </div>
                        {writing !== undefined && !readOnly ? (
                            <ModelSelector
                                providers={providers ?? []}
                                choice={helperChoiceOf(writing.improveModel)}
                                onChoice={pick}
                            />
                        ) : writing === undefined ? (
                            <Skeleton className="h-7 w-24" />
                        ) : null}
                    </li>
                    <li className="flex min-w-0 flex-col gap-2 px-3 py-2">
                        <div className="min-w-0">
                            <p className="text-sm text-foreground">{t("settings.writing.context")}</p>
                            <p className="text-xs text-muted-foreground">
                                {t("settings.writing.contextHint")}
                            </p>
                        </div>
                        {writing === undefined ? (
                            <Skeleton className="h-24 w-full" />
                        ) : (
                            <>
                                <Textarea
                                    value={context}
                                    maxLength={WRITING_CONTEXT_MAX}
                                    rows={4}
                                    disabled={readOnly}
                                    aria-label={t("settings.writing.context")}
                                    placeholder={t("settings.writing.contextPlaceholder")}
                                    onChange={(event) => setContext(event.target.value)}
                                />
                                <div className="flex min-w-0 items-center justify-end gap-2">
                                    <span className="text-xs text-muted-foreground tabular-nums">
                                        {context.length}/{WRITING_CONTEXT_MAX}
                                    </span>
                                    <Button
                                        size="sm"
                                        aria-disabled={!contextDirty || saving || readOnly}
                                        disabled={readOnly}
                                        onClick={() => void saveContext()}
                                    >
                                        {t("settings.writing.save")}
                                    </Button>
                                </div>
                            </>
                        )}
                    </li>
                    <li className="flex min-w-0 flex-col gap-2 px-3 py-2">
                        <div className="min-w-0">
                            <p className="text-sm text-foreground">{t("settings.writing.skills")}</p>
                            <p className="text-xs text-muted-foreground">
                                {skills.length === 0
                                    ? t("settings.writing.noSkills")
                                    : t("settings.writing.skillsHint", { max: WRITING_SKILLS_MAX })}
                            </p>
                        </div>
                        {writing === undefined ? (
                            <Skeleton className="h-7 w-48" />
                        ) : skills.length > 0 ? (
                            <div className="flex min-w-0 flex-wrap gap-1.5">
                                {skills.map((name) => {
                                    const on = writing.writingSkills.includes(name);
                                    return (
                                        <Button
                                            key={name}
                                            size="sm"
                                            variant={on ? "secondary" : "ghost"}
                                            aria-pressed={on}
                                            aria-disabled={readOnly || (!on && full)}
                                            title={!on && full ? t("settings.writing.skillsFull") : name}
                                            className="max-w-full"
                                            onClick={() => !readOnly && toggleSkill(name)}
                                        >
                                            <span className="truncate">{name}</span>
                                        </Button>
                                    );
                                })}
                            </div>
                        ) : null}
                    </li>
                </ul>
            </section>
            <OrgGuides readOnly={readOnly} />
        </div>
    );
}

function OrgGuides({ readOnly }: { readOnly: boolean }) {
    const t = useTranslations("polar");
    const [guides, setGuides] = useState<OrgWritingGuide[] | null | undefined>(undefined);

    useEffect(() => {
        let live = true;
        void orgWritingGuidesAction()
            .then((result) => live && setGuides(result.ok ? result.value : null))
            .catch(() => live && setGuides(null));
        return () => {
            live = false;
        };
    }, []);

    // Working from the personal shelf, there is no organization's guide to show.
    if (Array.isArray(guides) && guides.length === 0) return null;

    return (
        <section className="flex flex-col gap-2">
            <div className="min-w-0">
                <h2 className="text-sm font-medium text-foreground">
                    {t("settings.writing.orgTitle")}
                </h2>
                <p className="text-xs text-muted-foreground">{t("settings.writing.orgIntro")}</p>
            </div>
            {guides === undefined ? (
                <Skeleton className="h-24 w-full" />
            ) : guides === null ? (
                <p className="text-xs text-danger">{t("settings.writing.orgFailed")}</p>
            ) : (
                <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                    {guides.map((guide) => (
                        <OrgGuide
                            key={guide.id}
                            guide={guide}
                            readOnly={readOnly || !guide.canEdit}
                            onSaved={(text) =>
                                setGuides((current) =>
                                    current?.map((entry) =>
                                        entry.id === guide.id ? { ...entry, guide: text } : entry
                                    )
                                )
                            }
                        />
                    ))}
                </ul>
            )}
        </section>
    );
}

function OrgGuide({
    guide,
    readOnly,
    onSaved
}: {
    guide: OrgWritingGuide;
    readOnly: boolean;
    onSaved: (text: string) => void;
}) {
    const t = useTranslations("polar");
    const toast = useToast();
    const [text, setText] = useState(guide.guide);
    const [saving, setSaving] = useState(false);
    const dirty = text.trim() !== guide.guide.trim();

    async function save() {
        if (!dirty || saving || readOnly) return;
        setSaving(true);
        const result = await saveOrgWritingGuideAction({ orgId: guide.id, guide: text }).catch(
            () => null
        );
        setSaving(false);
        if (!result?.ok) {
            toast.show({ title: result?.error ?? t("settings.writing.failed") });
            return;
        }
        setText(result.value);
        onSaved(result.value);
    }

    return (
        <li className="flex min-w-0 flex-col gap-2 px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
                <p className="min-w-0 flex-1 truncate text-sm text-foreground" title={guide.name}>
                    {guide.name}
                </p>
                {readOnly ? <Badge>{t("settings.writing.orgReadOnly")}</Badge> : null}
            </div>
            {readOnly ? (
                <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                    {guide.guide.trim() || t("settings.writing.orgEmpty")}
                </p>
            ) : (
                <>
                    <Textarea
                        value={text}
                        rows={5}
                        maxLength={8_000}
                        aria-label={t("settings.writing.orgGuideLabel", { org: guide.name })}
                        placeholder={t("settings.writing.orgPlaceholder")}
                        onChange={(event) => setText(event.target.value)}
                    />
                    <div className="flex justify-end">
                        <Button
                            size="sm"
                            aria-disabled={!dirty || saving}
                            onClick={() => void save()}
                        >
                            {t("settings.writing.save")}
                        </Button>
                    </div>
                </>
            )}
        </li>
    );
}
