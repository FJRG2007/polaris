"use client";

/**
 * ModelSelector: provider and model, how hard it thinks, and who pays.
 *
 * Ported from AI Elements (github.com/vercel/ai-elements,
 * packages/elements/src/model-selector.tsx at ca8be60), Apache-2.0 - see the
 * LICENSE beside this file. Changed: built on the Polaris dropdown menu (a
 * portal with collision handling) instead of a dialog with a command list,
 * with the intelligence and payer sections Polar needs, and only the models
 * the server says this person can use - it never offers one of its own.
 */

import Link from "next/link";
import { Check } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger
} from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { INTELLIGENCE_LEVELS, type ModelChoice, type Payer } from "@/lib/polar/shared";

export interface ModelSelectorProvider {
    provider: string;
    name: string;
    payers: Payer[];
    models: Array<{ provider: string; model: string; name: string; reasoning: boolean; attachment?: boolean }>;
}

function Mark({ on }: { on: boolean }) {
    return <Check className={on ? "ml-auto h-3.5 w-3.5 text-primary" : "ml-auto h-3.5 w-3.5 opacity-0"} />;
}

export function ModelSelector({
    providers,
    choice,
    onChoice
}: {
    providers: ModelSelectorProvider[];
    choice: ModelChoice | null;
    onChoice: (choice: ModelChoice) => void;
}) {
    const t = useTranslations("polar");
    const provider = providers.find((entry) => entry.provider === choice?.provider);
    const model = provider?.models.find((entry) => entry.model === choice?.model);
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    title={t("picker.title")}
                    className="inline-flex h-7 min-w-0 max-w-[60%] items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-card-hover hover:text-foreground"
                >
                    <span className="truncate text-foreground">{model?.name ?? t("picker.none")}</span>
                    {choice && model?.reasoning ? (
                        <span className="shrink-0">{t(`intelligence.${choice.intelligence}`)}</span>
                    ) : null}
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-96 w-72 overflow-y-auto">
                {providers.map((entry) => (
                    <div key={entry.provider}>
                        <DropdownMenuLabel>{entry.name}</DropdownMenuLabel>
                        {entry.models.map((option) => (
                            <DropdownMenuItem
                                key={option.model}
                                onSelect={() =>
                                    onChoice({
                                        kind: "language",
                                        provider: option.provider,
                                        model: option.model,
                                        intelligence: choice?.intelligence ?? "balanced",
                                        payer: null
                                    })
                                }
                            >
                                <span className="min-w-0 truncate" title={option.name}>
                                    {option.name}
                                </span>
                                <Mark on={option.provider === choice?.provider && option.model === choice?.model} />
                            </DropdownMenuItem>
                        ))}
                    </div>
                ))}
                {choice ? (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel>{t("picker.intelligence")}</DropdownMenuLabel>
                        {INTELLIGENCE_LEVELS.map((level) => (
                            <DropdownMenuItem
                                key={level}
                                disabled={!model?.reasoning}
                                title={model?.reasoning ? undefined : t("picker.noReasoning")}
                                onSelect={() => onChoice({ ...choice, intelligence: level })}
                            >
                                {t(`intelligence.${level}`)}
                                <Mark on={choice.intelligence === level} />
                            </DropdownMenuItem>
                        ))}
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel>{t("picker.payer")}</DropdownMenuLabel>
                        {(provider?.payers ?? []).map((payer) => (
                            <DropdownMenuItem key={payer} onSelect={() => onChoice({ ...choice, payer })}>
                                {t(`picker.${payer}`)}
                                <Mark on={(choice.payer ?? provider?.payers[0]) === payer} />
                            </DropdownMenuItem>
                        ))}
                        <DropdownMenuItem disabled title={t("picker.signinReason")}>
                            <span className="text-foreground-subtle">{t("picker.signin")}</span>
                        </DropdownMenuItem>
                    </>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                    <Link href="/account/ai-keys">{t("picker.manage")}</Link>
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
