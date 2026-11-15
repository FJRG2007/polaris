"use client";

/**
 * EffortPill: how hard the model thinks, as a pill in the row under the input
 * (DeepSeek chat-demo's "DeepThink", github.com/deepseek-ai/chat-demo,
 * src/components/chatInput/ChatInput.tsx). A model whose thinking is a switch
 * gets an on/off "Think" button with `aria-pressed`; one with a ladder gets a
 * menu of only the steps it offers. The caller hides it for a model that does
 * not reason.
 */

import { Brain, Check } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuTrigger
} from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";

const PILL =
    "inline-flex h-7 min-w-0 max-w-[40%] shrink items-center gap-1.5 rounded-full border border-border px-2.5 text-xs text-muted-foreground hover:bg-card-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:px-3";

export function EffortPill<T extends string>({
    toggle = false,
    levels,
    value,
    onChange,
    labelOf,
    disabled = false
}: {
    /** An on/off switch: the first level is off, the last is on. */
    toggle?: boolean;
    /** The steps on offer, ascending. */
    levels: readonly T[];
    /** Null is the tool's own default, which the pill names as such. */
    value: T | null;
    onChange: (level: T) => void;
    labelOf: (level: T) => string;
    disabled?: boolean;
}) {
    const t = useTranslations("polar");
    const off = levels[0];
    const on = levels.at(-1);
    if (off === undefined || on === undefined) return null;
    if (toggle) {
        const pressed = value !== off;
        return (
            <button
                type="button"
                aria-pressed={pressed}
                title={t("effort.thinkHint")}
                disabled={disabled}
                onClick={() => onChange(pressed ? off : on)}
                className={`${PILL} ${pressed ? "border-primary/40 bg-primary/10 text-primary hover:text-primary" : ""}`}
            >
                <Brain className="size-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 truncate">{t("effort.think")}</span>
            </button>
        );
    }
    const current = value === null ? t("effort.default") : labelOf(value);
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    disabled={disabled}
                    title={`${t("effort.title")}: ${current}`}
                    aria-label={`${t("effort.title")}: ${current}`}
                    className={PILL}
                >
                    <Brain className="size-3.5 shrink-0" aria-hidden />
                    <span className="min-w-0 truncate">{current}</span>
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
                <DropdownMenuLabel>{t("effort.title")}</DropdownMenuLabel>
                {levels.map((level) => (
                    <DropdownMenuItem
                        key={level}
                        role="menuitemradio"
                        aria-checked={level === value}
                        className="[@media(pointer:coarse)]:min-h-10"
                        onSelect={() => onChange(level)}
                    >
                        <span className="min-w-0 truncate" title={labelOf(level)}>
                            {labelOf(level)}
                        </span>
                        <Check
                            aria-hidden
                            className={
                                level === value
                                    ? "ml-auto size-3.5 shrink-0 text-primary"
                                    : "ml-auto size-3.5 shrink-0 opacity-0"
                            }
                        />
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
