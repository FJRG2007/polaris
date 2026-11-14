"use client";

/**
 * An identity's emails or phones, one row each, the first being the main one.
 *
 * The main one is Bitwarden's own email or phone field, so every other client
 * still sees one; the rest are custom fields (`contactField`). Making a row the
 * main one moves it to the top.
 */

import * as core from "@polaris/core";
import { Button, Input, cn } from "@polaris/ui";
import { Plus, Star, X } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";

/** What is wrong with one row, or null: empty is unfinished, never wrong. */
export function contactProblem(kind: "email" | "phone", value: string): "invalidEmail" | "invalidPhone" | null {
    if (value.trim() === "") return null;
    if (kind === "email") return core.looksLikeEmail(core.normalizeContactEmail(value)) ? null : "invalidEmail";
    return core.looksLikePhone(core.normalizeContactPhone(value)) ? null : "invalidPhone";
}

/** The rows with `at` moved to the top. */
export function withPrimary(values: readonly string[], at: number): string[] {
    const chosen = values[at];
    if (chosen === undefined || at === 0) return [...values];
    return [chosen, ...values.filter((_, index) => index !== at)];
}

export function IdentityContactList({
    kind,
    label,
    values,
    onChange
}: {
    kind: "email" | "phone";
    label: string;
    /** Every row, the main one first. Never empty: one row is always drawn. */
    values: readonly string[];
    onChange: (next: string[]) => void;
}) {
    const t = useTranslations("vault");
    const rows = values.length > 0 ? values : [""];
    const full = rows.length >= core.MAX_EXTRA_CONTACTS + 1;
    return (
        <div className="flex min-w-0 flex-col gap-2">
            {rows.map((value, at) => {
                const problem = contactProblem(kind, value);
                return (
                    <div key={at} className="flex min-w-0 flex-col gap-1">
                        <div className="flex min-w-0 items-center gap-1">
                            <Input
                                className="min-w-0 flex-1"
                                type={kind === "email" ? "email" : "tel"}
                                value={value}
                                onChange={(event) =>
                                    onChange(rows.map((one, index) => (index === at ? event.target.value : one)))
                                }
                                aria-label={rows.length > 1 ? `${label} ${at + 1}` : label}
                                aria-invalid={problem ? true : undefined}
                                autoComplete="off"
                            />
                            {rows.length > 1 ? (
                                <>
                                    <Button
                                        type="button"
                                        size="icon"
                                        variant="ghost"
                                        disabled={at === 0}
                                        onClick={() => onChange(withPrimary(rows, at))}
                                        aria-label={at === 0 ? t("identity.contacts.primary") : t("identity.contacts.makePrimary")}
                                        title={at === 0 ? t("identity.contacts.primary") : t("identity.contacts.makePrimary")}
                                    >
                                        <Star className={cn("size-4 shrink-0", at === 0 && "fill-current")} />
                                    </Button>
                                    <Button
                                        type="button"
                                        size="icon"
                                        variant="ghost"
                                        onClick={() => onChange(rows.filter((_, index) => index !== at))}
                                        aria-label={t("identity.contacts.remove")}
                                        title={t("identity.contacts.remove")}
                                    >
                                        <X className="size-4 shrink-0" />
                                    </Button>
                                </>
                            ) : null}
                        </div>
                        {problem ? (
                            <p role="alert" className="text-xs text-destructive">
                                {t(`identity.contacts.${problem}`)}
                            </p>
                        ) : null}
                    </div>
                );
            })}
            {full ? null : (
                <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="self-start"
                    onClick={() => onChange([...rows, ""])}
                >
                    <Plus className="size-4 shrink-0" />
                    {kind === "email" ? t("identity.contacts.addEmail") : t("identity.contacts.addPhone")}
                </Button>
            )}
        </div>
    );
}
