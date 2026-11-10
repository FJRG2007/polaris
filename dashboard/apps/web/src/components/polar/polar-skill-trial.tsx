"use client";

/**
 * A skill being tried in a temporary chat, before it is added. The Skills
 * settings open `/polar?new=1&skill=<catalog id>` for a built-in one, or
 * `skill=draft` with the editor's draft left in this tab's session storage.
 * The chat sends it with every turn; the server checks it again each time
 * and honours it only in a temporary chat. From here it can be added.
 */

import { useState } from "react";
import { Button } from "@polaris/ui";
import { FlaskConical, Plus } from "lucide-react";
import { catalogSkill } from "@/lib/polar/skills/catalog";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { TRIAL_SKILL_KEY, trialSkillSchema, type TrialSkill } from "@/lib/polar/skills/shared";

export interface SkillTrial {
    trial: TrialSkill;
    name: string;
}

/** The trial the address names, or null; a draft is taken out of storage once read. */
export function trialFromAddress(param: string | null): SkillTrial | null {
    if (!param) return null;
    if (param !== "draft") {
        const found = catalogSkill(param);
        return found ? { trial: { catalog: found.id }, name: found.name } : null;
    }
    let raw: string | null = null;
    try {
        raw = window.sessionStorage.getItem(TRIAL_SKILL_KEY);
        window.sessionStorage.removeItem(TRIAL_SKILL_KEY);
    } catch {
        return null;
    }
    if (!raw) return null;
    try {
        const parsed = trialSkillSchema.safeParse({ draft: JSON.parse(raw) });
        return parsed.success && "draft" in parsed.data
            ? { trial: parsed.data, name: parsed.data.draft.name }
            : null;
    } catch {
        return null;
    }
}

export function SkillTrialBar({ trial }: { trial: SkillTrial }) {
    const t = useTranslations("polar");
    const [state, setState] = useState<"idle" | "pending" | "added">("idle");
    const [error, setError] = useState<string | null>(null);
    // A built-in skill is shown by its translated title, never its machine name.
    const name =
        "catalog" in trial.trial
            ? t(`settings.skills.catalog.${trial.trial.catalog}.title` as never)
            : trial.name;

    async function add() {
        setState("pending");
        setError(null);
        const response = await fetch("/api/polar/skills/trial", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(trial.trial)
        }).catch(() => null);
        if (response?.ok) return setState("added");
        const body = (await response?.json().catch(() => null)) as { error?: string } | null;
        setState("idle");
        setError(body?.error || t("skillTrial.addFailed"));
    }

    return (
        <div className="flex flex-col gap-1 rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
            <div className="flex min-w-0 items-center gap-2">
                <FlaskConical className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate" title={name}>
                    {t("skillTrial.banner", { name })}
                </span>
                {state === "added" ? (
                    <span role="status" className="shrink-0 text-success-ink">
                        {t("skillTrial.added")}
                    </span>
                ) : (
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="shrink-0"
                        disabled={state === "pending"}
                        onClick={() => void add()}
                    >
                        <Plus className="h-3.5 w-3.5 shrink-0" />
                        {t("skillTrial.add")}
                    </Button>
                )}
            </div>
            {error ? (
                <p role="alert" className="text-danger">
                    {error}
                </p>
            ) : null}
        </div>
    );
}
