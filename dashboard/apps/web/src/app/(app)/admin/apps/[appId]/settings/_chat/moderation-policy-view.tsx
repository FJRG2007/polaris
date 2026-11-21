"use client";

/**
 * The instance's moderation policy for Chat (`lib/chat/moderation-policy.ts`):
 * whether disappearing messages may be kept, and when an account that many
 * people block or report stops reaching new people.
 *
 * Switches save at once; the numbers save when one is left with a value the
 * schema accepts. A refusal puts back what the server last held.
 */

import { useState } from "react";
import { Input, Switch } from "@polaris/ui";
import { runAction } from "@/lib/run-action";
import { setModerationPolicyAction } from "./actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { restrictionSchema, type ModerationPolicy, type RestrictionPolicy } from "@/lib/chat/moderation-policy-rules";

const LIMITS = {
    threshold: restrictionSchema.shape.threshold,
    windowDays: restrictionSchema.shape.windowDays,
    hours: restrictionSchema.shape.hours
} as const;
type NumberField = keyof typeof LIMITS;

export function ModerationPolicyView({ initial }: { initial: ModerationPolicy }) {
    const t = useTranslations("admin");
    const [held, setHeld] = useState(initial);
    const [shown, setShown] = useState(initial);
    const [drafts, setDrafts] = useState<Partial<Record<NumberField, string>>>({});
    const [error, setError] = useState("");

    const save = async (next: ModerationPolicy) => {
        if (JSON.stringify(next) === JSON.stringify(held)) return;
        setError("");
        setShown(next);
        const result = await runAction(() => setModerationPolicyAction(next), setError);
        if (!result || result.error) {
            if (result?.error) setError(result.error);
            setShown(held);
            return;
        }
        setHeld(next);
    };
    const restriction = (change: Partial<RestrictionPolicy>) =>
        void save({ ...shown, restriction: { ...shown.restriction, ...change } });

    const number = (field: NumberField) => {
        const draft = drafts[field] ?? String(shown.restriction[field]);
        const parsed = LIMITS[field].safeParse(Number(draft));
        const invalid = draft.trim() === "" || !parsed.success;
        return (
            <label className="flex items-center justify-between gap-3">
                <span className="min-w-0 text-sm">{t(`chat.moderation.${field}`)}</span>
                <Input
                    type="number"
                    inputMode="numeric"
                    className="w-24 shrink-0"
                    value={draft}
                    disabled={!shown.restriction.enabled}
                    aria-invalid={invalid || undefined}
                    onChange={(event) => setDrafts((was) => ({ ...was, [field]: event.target.value }))}
                    onBlur={() => {
                        if (parsed.success) restriction({ [field]: parsed.data });
                        setDrafts((was) => ({ ...was, [field]: undefined }));
                    }}
                />
            </label>
        );
    };

    return (
        <section className="mt-8 flex flex-col gap-4">
            <div>
                <h2 className="text-base font-semibold">{t("chat.moderation.title")}</h2>
                <p className="text-sm text-muted-foreground">{t("chat.moderation.description")}</p>
            </div>
            <label className="flex items-start justify-between gap-3">
                <span className="flex min-w-0 flex-col">
                    <span className="text-sm font-medium">{t("chat.moderation.keep")}</span>
                    <span className="text-xs text-muted-foreground">{t("chat.moderation.keepHint")}</span>
                </span>
                <Switch
                    checked={shown.keep === "allowed"}
                    onChange={(on: boolean) => void save({ ...shown, keep: on ? "allowed" : "forbidden" })}
                    aria-label={t("chat.moderation.keep")}
                />
            </label>
            <label className="flex items-start justify-between gap-3">
                <span className="flex min-w-0 flex-col">
                    <span className="text-sm font-medium">{t("chat.moderation.restriction")}</span>
                    <span className="text-xs text-muted-foreground">{t("chat.moderation.restrictionHint")}</span>
                </span>
                <Switch
                    checked={shown.restriction.enabled}
                    onChange={(on: boolean) => restriction({ enabled: on })}
                    aria-label={t("chat.moderation.restriction")}
                />
            </label>
            {number("threshold")}
            {number("windowDays")}
            {number("hours")}
            {error ? <p className="text-sm text-danger">{error}</p> : null}
        </section>
    );
}
