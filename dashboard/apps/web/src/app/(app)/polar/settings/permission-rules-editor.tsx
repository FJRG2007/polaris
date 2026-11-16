"use client";

/**
 * An agent's allow, ask and deny rules (`lib/polar/agents/permissions.ts`),
 * one row per tool and pattern. The last rule that matches wins, so the rows
 * can be moved; each is checked against the server's schema as it is typed.
 */

import { Button, Input, Select } from "@polaris/ui";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    PERMISSION_EFFECTS,
    PERMISSION_RULES_MAX,
    permissionRuleSchema,
    type PermissionRule
} from "@/lib/polar/agents/permissions";

/** A new row: asks before any use of a tool the person then names. */
const NEW_RULE: PermissionRule = { action: "", resource: "*", effect: "ask" };

export function PermissionRulesEditor({
    value,
    onChange
}: {
    value: readonly PermissionRule[];
    onChange: (rules: PermissionRule[]) => void;
}) {
    const t = useTranslations("polar");
    const effects = PERMISSION_EFFECTS.map((effect) => ({
        value: effect,
        label: t(`settings.agents.rules.effects.${effect}`)
    }));
    const update = (index: number, patch: Partial<PermissionRule>) =>
        onChange(value.map((rule, at) => (at === index ? { ...rule, ...patch } : rule)));
    const move = (index: number, by: -1 | 1) => {
        const next = [...value];
        const [rule] = next.splice(index, 1);
        next.splice(index + by, 0, rule!);
        onChange(next);
    };

    return (
        <fieldset className="flex min-w-0 flex-col gap-2 text-sm">
            <legend>{t("settings.agents.rules.title")}</legend>
            <span className="text-xs text-muted-foreground">
                {value.length > 0 ? t("settings.agents.rules.hint") : t("settings.agents.rules.empty")}
            </span>
            {value.length > 0 ? (
                <ol className="flex flex-col gap-2">
                    {value.map((rule, index) => {
                        const checked = permissionRuleSchema.safeParse(rule);
                        // An action not typed yet is incomplete, not wrong.
                        const invalid = !checked.success && rule.action.trim() !== "";
                        return (
                            <li key={index} className="flex min-w-0 flex-col gap-1">
                                <div className="flex min-w-0 flex-wrap items-center gap-2">
                                    <Input
                                        value={rule.action}
                                        maxLength={64}
                                        className="h-8 min-w-0 flex-1 basis-28"
                                        placeholder={t("settings.agents.rules.actionPlaceholder")}
                                        aria-label={t("settings.agents.rules.action", { index: index + 1 })}
                                        aria-invalid={invalid ? true : undefined}
                                        onChange={(event) => update(index, { action: event.target.value })}
                                    />
                                    <Input
                                        value={rule.resource}
                                        maxLength={500}
                                        className="h-8 min-w-0 flex-[2_1_8rem] font-mono text-xs"
                                        placeholder="*"
                                        aria-label={t("settings.agents.rules.pattern", { index: index + 1 })}
                                        onChange={(event) => update(index, { resource: event.target.value })}
                                    />
                                    <div className="flex shrink-0 items-center gap-1">
                                        <Select
                                            value={rule.effect}
                                            options={effects}
                                            className="h-8 w-28"
                                            aria-label={t("settings.agents.rules.effect", { index: index + 1 })}
                                            onValueChange={(effect) =>
                                                update(index, { effect: effect as PermissionRule["effect"] })
                                            }
                                        />
                                        <Button
                                            type="button"
                                            size="icon-sm"
                                            variant="ghost"
                                            disabled={index === 0}
                                            aria-label={t("settings.agents.rules.up")}
                                            title={t("settings.agents.rules.up")}
                                            onClick={() => move(index, -1)}
                                        >
                                            <ArrowUp className="size-4 shrink-0" />
                                        </Button>
                                        <Button
                                            type="button"
                                            size="icon-sm"
                                            variant="ghost"
                                            disabled={index === value.length - 1}
                                            aria-label={t("settings.agents.rules.down")}
                                            title={t("settings.agents.rules.down")}
                                            onClick={() => move(index, 1)}
                                        >
                                            <ArrowDown className="size-4 shrink-0" />
                                        </Button>
                                        <Button
                                            type="button"
                                            size="icon-sm"
                                            variant="ghost"
                                            aria-label={t("settings.agents.rules.remove")}
                                            title={t("settings.agents.rules.remove")}
                                            onClick={() => onChange(value.filter((_, at) => at !== index))}
                                        >
                                            <Trash2 className="size-4 shrink-0" />
                                        </Button>
                                    </div>
                                </div>
                                {invalid ? (
                                    <span className="text-xs text-danger">{t("settings.agents.rules.invalid")}</span>
                                ) : null}
                            </li>
                        );
                    })}
                </ol>
            ) : null}
            <Button
                type="button"
                size="sm"
                variant="outline"
                className="self-start"
                disabled={value.length >= PERMISSION_RULES_MAX}
                onClick={() => onChange([...value, NEW_RULE])}
            >
                <Plus className="h-3.5 w-3.5 shrink-0" />
                {t("settings.agents.rules.add")}
            </Button>
        </fieldset>
    );
}
