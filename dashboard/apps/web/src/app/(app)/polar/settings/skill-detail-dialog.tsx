"use client";

/**
 * One skill opened: its SKILL.md, highlighted, and for a built-in or Enigma
 * skill the edit layered over it - what changed against upstream, Reset, and
 * when upstream moved after the edit, the merge with keep-mine and
 * take-theirs. A person edits their own tier; an administrator may also edit
 * the instance's, for everybody.
 */

import { useEffect, useState } from "react";
import { Eye, GitMerge, Pencil, RotateCcw } from "lucide-react";
import {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    SegmentedControl,
    Skeleton
} from "@polaris/ui";
import * as layers from "@/lib/polar/skills/overrides";
import { SKILL_DESCRIPTION_MAX, type SkillView } from "@/lib/polar/skills/shared";
import { CodeEditor, CodeView } from "@/components/json-view";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { OverrideSummary } from "@/lib/polar/skills/override-store";
import {
    keepSkillOverrideAction,
    readUpstreamSkillAction,
    resetSkillOverrideAction,
    saveSkillOverrideAction,
    type UpstreamSkillAnswer
} from "./skill-override-actions";

/** What the dialog is open on. */
export type SkillTarget = { kind: "upstream"; key: string } | { kind: "own"; skill: SkillView } | null;

type Tab = "file" | "changes" | "edit";
const CONFLICT = /^(<<<<<<<|=======|>>>>>>>)( |$)/m;

/** What a list row shows for a skill once the dialog changed it. */
export function summaryOf(answer: UpstreamSkillAnswer): OverrideSummary {
    const { resolved, enabled } = answer.view;
    return {
        edited: resolved.user ? "user" : resolved.instance ? "instance" : null,
        upstreamChanged: Boolean(resolved.user?.upstreamChanged || resolved.instance?.upstreamChanged),
        enabled: enabled ?? true
    };
}

/** The badges a list row shows for an edited skill. */
export function EditedBadges({ summary }: { summary: OverrideSummary | undefined }) {
    const t = useTranslations("polar");
    if (!summary?.edited) return null;
    return (
        <>
            <Badge variant="primary" className="shrink-0">
                {summary.edited === "user" ? t("settings.skills.upstream.editedMine") : t("settings.skills.upstream.editedAll")}
            </Badge>
            {summary.upstreamChanged ? (
                <Badge variant="warning" className="shrink-0">
                    {t("settings.skills.upstream.moved")}
                </Badge>
            ) : null}
        </>
    );
}

export function SkillDetailDialog({
    target,
    readOnly,
    onClose,
    onChanged
}: {
    target: SkillTarget;
    readOnly: boolean;
    onClose: () => void;
    onChanged?: (key: string, summary: OverrideSummary) => void;
}) {
    const t = useTranslations("polar");
    const key = target?.kind === "upstream" ? target.key : null;
    const [answer, setAnswer] = useState<UpstreamSkillAnswer | null>(null);
    const [failed, setFailed] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);
    const [tab, setTab] = useState<Tab>("file");
    const [tier, setTier] = useState<layers.OverrideTier>("user");
    const [draft, setDraft] = useState<layers.SkillText>({ description: "", instructions: "" });
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!key) return;
        let live = true;
        setAnswer(null);
        setFailed(null);
        setError(null);
        setTab("file");
        void readUpstreamSkillAction({ skill: key }).then(
            (result) => {
                if (!live) return;
                if (!result.ok) return setFailed(result.error);
                setAnswer(result.value);
                const { resolved } = result.value.view;
                setTier(!resolved.user && resolved.instance && result.value.canInstance ? "instance" : "user");
            },
            () => live && setFailed("")
        );
        return () => {
            live = false;
        };
    }, [key, attempt]);

    const resolved = key ? (answer?.view.resolved ?? null) : null;
    const name = target?.kind === "own" ? target.skill.name : (answer?.view.name ?? layers.parseSkillKey(key ?? "")?.name ?? "");
    const effective: layers.SkillText | null =
        target?.kind === "own" ? target.skill : resolved ? { description: resolved.description, instructions: resolved.instructions } : null;
    const below = resolved ? layers.belowTier(resolved, tier) : null;
    const tierLayer = resolved ? resolved[tier] : null;
    const tierText = tierLayer?.text ?? below;

    function startEdit(text: layers.SkillText) {
        setDraft(text);
        setError(null);
        setTab("edit");
    }

    function apply(result: { ok: true; value: UpstreamSkillAnswer } | { ok: false; error: string }) {
        setPending(false);
        if (!result.ok) return setError(result.error);
        setError(null);
        setAnswer(result.value);
        if (key) onChanged?.(key, summaryOf(result.value));
    }

    async function save() {
        if (!key || !below) return;
        setPending(true);
        apply(
            await saveSkillOverrideAction({
                skill: key,
                tier,
                against: layers.textHash(below),
                description: draft.description,
                instructions: draft.instructions
            })
        );
        setTab("changes");
    }

    async function reset() {
        if (!key) return;
        setPending(true);
        apply(await resetSkillOverrideAction({ skill: key, tier }));
        setTab("file");
    }

    async function keepMine() {
        if (!key) return;
        setPending(true);
        apply(await keepSkillOverrideAction({ skill: key, tier }));
    }

    function merge() {
        if (!tierLayer || !below) return;
        const labels = { mine: t("settings.skills.upstream.mineLabel"), theirs: t("settings.skills.upstream.theirsLabel") };
        const merged = layers.mergeThree(tierLayer.base.instructions, tierLayer.text.instructions, below.instructions, labels);
        const description =
            tierLayer.text.description === tierLayer.base.description ? below.description : tierLayer.text.description;
        startEdit({ description, instructions: merged.text });
    }

    const checked = layers.overrideTextSchema.safeParse(draft);
    const conflicted = CONFLICT.test(draft.instructions);
    const unchanged = tierText !== null && draft.description === tierText.description && draft.instructions === tierText.instructions;
    const canSave = checked.success && !conflicted && !unchanged && !pending;
    const editable = !readOnly && target?.kind === "upstream" && resolved !== null;
    const canTier = answer?.canInstance === true;

    const tabs: { value: Tab; label: string }[] = [
        { value: "file", label: t("settings.skills.upstream.tabFile") },
        ...(tierLayer ? [{ value: "changes" as const, label: t("settings.skills.upstream.tabChanges") }] : []),
        ...(editable ? [{ value: "edit" as const, label: t("settings.skills.upstream.tabEdit") }] : [])
    ];

    return (
        <Dialog open={target !== null} onOpenChange={(next) => !next && !pending && onClose()}>
            <DialogContent className="flex max-h-[90dvh] flex-col sm:max-w-3xl">
                <DialogHeader>
                    <DialogTitle className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-mono" title={name}>
                            {name}
                        </span>
                        {key ? (
                            <Badge variant="neutral" className="shrink-0">
                                {key.startsWith("enigma:") ? t("settings.skills.upstream.enigma") : t("settings.skills.upstream.builtin")}
                            </Badge>
                        ) : null}
                    </DialogTitle>
                    <DialogDescription className="line-clamp-3" title={effective?.description}>
                        {effective?.description ?? t("settings.skills.upstream.loading")}
                    </DialogDescription>
                </DialogHeader>

                <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto [&>*]:shrink-0">
                    {failed !== null ? (
                        <div role="alert" className="flex flex-col items-start gap-2 text-sm">
                            <p className="text-danger">{failed || t("settings.skills.upstream.loadFailed")}</p>
                            <Button type="button" size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
                                {t("settings.skills.upstream.retry")}
                            </Button>
                        </div>
                    ) : !effective ? (
                        <div className="flex flex-col gap-2" aria-busy="true">
                            <Skeleton className="h-8 w-48" />
                            <Skeleton className="h-64 w-full" />
                        </div>
                    ) : (
                        <>
                            {canTier && target?.kind === "upstream" ? (
                                <SegmentedControl<layers.OverrideTier>
                                    size="sm"
                                    aria-label={t("settings.skills.upstream.tier")}
                                    value={tier}
                                    onValueChange={(next) => {
                                        setTier(next);
                                        if (tab === "edit" && resolved) {
                                            const layer = resolved[next];
                                            startEdit(layer?.text ?? layers.belowTier(resolved, next));
                                        }
                                    }}
                                    options={[
                                        { value: "user", label: t("settings.skills.upstream.tierMine") },
                                        { value: "instance", label: t("settings.skills.upstream.tierAll") }
                                    ]}
                                />
                            ) : null}
                            {tierLayer?.upstreamChanged ? (
                                <div className="flex flex-col gap-2 rounded-md border border-warning-edge bg-warning-soft p-3 text-sm text-warning-ink">
                                    <p>{t("settings.skills.upstream.movedBody")}</p>
                                    {!readOnly ? (
                                        <div className="flex flex-wrap gap-2">
                                            <Button type="button" size="sm" variant="outline" disabled={pending} onClick={merge}>
                                                <GitMerge className="h-3.5 w-3.5 shrink-0" />
                                                {t("settings.skills.upstream.merge")}
                                            </Button>
                                            <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => void keepMine()}>
                                                {t("settings.skills.upstream.keepMine")}
                                            </Button>
                                            <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => void reset()}>
                                                {t("settings.skills.upstream.takeTheirs")}
                                            </Button>
                                        </div>
                                    ) : null}
                                </div>
                            ) : null}
                            {tabs.length > 1 ? (
                                <SegmentedControl<Tab>
                                    size="sm"
                                    aria-label={t("settings.skills.upstream.view")}
                                    value={tab}
                                    onValueChange={(next) => {
                                        if (next === "edit" && tierText) startEdit(tierText);
                                        else setTab(next);
                                    }}
                                    options={tabs}
                                />
                            ) : null}
                            {tab === "file" ? (
                                <CodeView
                                    value={layers.renderSkillMarkdown(name, effective)}
                                    language="markdown"
                                    label={t("settings.skills.upstream.fileLabel")}
                                    className="max-h-[55dvh]"
                                />
                            ) : null}
                            {tab === "changes" && tierLayer && below ? (
                                <CodeView
                                    value={layers.unifiedDiff(
                                        layers.renderSkillMarkdown(name, below),
                                        layers.renderSkillMarkdown(name, tierLayer.text),
                                        { from: t("settings.skills.upstream.theirsLabel"), to: t("settings.skills.upstream.mineLabel") }
                                    )}
                                    language="diff"
                                    label={t("settings.skills.upstream.tabChanges")}
                                    className="max-h-[55dvh]"
                                />
                            ) : null}
                            {tab === "edit" && editable ? (
                                <div className="flex flex-col gap-3 text-sm">
                                    <div className="flex flex-col gap-1">
                                        <label htmlFor="skill-override-description">{t("settings.skills.editor.description")} *</label>
                                        <Input
                                            id="skill-override-description"
                                            value={draft.description}
                                            maxLength={SKILL_DESCRIPTION_MAX}
                                            aria-invalid={draft.description.trim() ? undefined : true}
                                            onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
                                        />
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        <label htmlFor="skill-override-instructions">{t("settings.skills.editor.instructions")} *</label>
                                        <CodeEditor
                                            id="skill-override-instructions"
                                            value={draft.instructions}
                                            language="markdown"
                                            invalid={conflicted || (!checked.success && draft.instructions.trim() !== "")}
                                            className="max-h-[45dvh]"
                                            onChange={(instructions) => setDraft((current) => ({ ...current, instructions }))}
                                        />
                                        <span className={conflicted ? "text-xs text-danger" : "text-xs text-muted-foreground"}>
                                            {conflicted
                                                ? t("settings.skills.upstream.conflicts")
                                                : draft.instructions.length > layers.OVERRIDE_INSTRUCTIONS_MAX
                                                  ? t("settings.skills.errors.too_long")
                                                  : tier === "instance"
                                                    ? t("settings.skills.upstream.hintAll")
                                                    : t("settings.skills.upstream.hintMine")}
                                        </span>
                                    </div>
                                </div>
                            ) : null}
                            {error ? (
                                <p role="alert" className="text-sm text-danger">
                                    {error}
                                </p>
                            ) : null}
                        </>
                    )}
                </div>

                <DialogFooter className="flex-wrap">
                    {tab === "edit" && editable ? (
                        <>
                            <Button type="button" variant="ghost" disabled={pending} onClick={() => setTab("file")}>
                                <Eye className="h-3.5 w-3.5 shrink-0" />
                                {t("settings.skills.cancel")}
                            </Button>
                            <Button type="button" aria-disabled={!canSave} disabled={pending} onClick={() => canSave && void save()}>
                                {t("settings.skills.save")}
                            </Button>
                        </>
                    ) : (
                        <>
                            {tierLayer && !readOnly ? (
                                <Button type="button" variant="ghost" disabled={pending} onClick={() => void reset()}>
                                    <RotateCcw className="h-3.5 w-3.5 shrink-0" />
                                    {t("settings.skills.upstream.reset")}
                                </Button>
                            ) : null}
                            {editable && tierText ? (
                                <Button type="button" variant="outline" disabled={pending} onClick={() => startEdit(tierText)}>
                                    <Pencil className="h-3.5 w-3.5 shrink-0" />
                                    {t("settings.skills.edit")}
                                </Button>
                            ) : null}
                            <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
                                {t("settings.skills.upstream.close")}
                            </Button>
                        </>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
