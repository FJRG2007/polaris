"use client";

/**
 * A key's standing with Polar's router, and the allowance its owner sets on
 * it: the status badge in the keys table, and the dialog the limits are edited
 * in.
 */

import { useState } from "react";
import { formatTokens } from "@/lib/polar/usage-format";
import { RelativeTime } from "@/components/relative-time";
import type { ModelKeyView } from "@/lib/agents/model-keys";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import {
    KEY_LIMIT_FIELDS,
    keyLimitsSchema,
    type KeyHealthView,
    type KeyLimits,
    type KeyState
} from "@/lib/agents/key-limits";
import {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input
} from "@polaris/ui";

const TONE: Record<KeyState, "success" | "warning" | "danger"> = {
    ready: "success",
    cooling: "warning",
    refused: "danger",
    no_credit: "warning",
    limit_day: "warning",
    limit_month: "warning"
};

const REASONS = ["key", "credit", "paid", "rate", "busy", "down", "model"] as const;

/** The badge, and for a cool-down when it ends and why. */
export function KeyStanding({ status, compact = false }: { status: KeyHealthView; compact?: boolean }) {
    const t = useTranslations("components");
    const tp = useTranslations("polar");
    const reason =
        status.reason && (REASONS as readonly string[]).includes(status.reason)
            ? tp(`routing.reasons.${status.reason as (typeof REASONS)[number]}`)
            : null;
    return (
        <span className="flex min-w-0 flex-col items-start gap-0.5">
            <Badge variant={TONE[status.state]} className="shrink-0">
                {t(`modelKeys.status.${status.state}`)}
            </Badge>
            {!compact && status.until ? (
                <span className="text-xs text-muted-foreground">
                    {t("modelKeys.status.until")} <RelativeTime iso={status.until} tense="future" />
                    {reason ? ` - ${reason}` : null}
                </span>
            ) : null}
        </span>
    );
}

type Draft = Record<(typeof KEY_LIMIT_FIELDS)[number], string>;

function draftOf(limits: KeyLimits): Draft {
    return Object.fromEntries(
        KEY_LIMIT_FIELDS.map((field) => [field, limits[field] === null ? "" : String(limits[field])])
    ) as Draft;
}

/** The draft as limits, or the first field that does not read as one. */
export function limitsOfDraft(
    draft: Draft
): { ok: true; limits: KeyLimits } | { ok: false; field: (typeof KEY_LIMIT_FIELDS)[number] } {
    const shaped: Record<string, number | null> = {};
    for (const field of KEY_LIMIT_FIELDS) {
        const text = draft[field].trim();
        if (text === "") {
            shaped[field] = null;
            continue;
        }
        if (!/^\d+$/.test(text)) return { ok: false, field };
        shaped[field] = Number(text);
    }
    const parsed = keyLimitsSchema.safeParse(shaped);
    if (parsed.success) return { ok: true, limits: parsed.data };
    const field = parsed.error.issues[0]?.path[0] as (typeof KEY_LIMIT_FIELDS)[number];
    return { ok: false, field };
}

export function KeyLimitsDialog({
    keyRow,
    status,
    onClose,
    onSave
}: {
    keyRow: ModelKeyView;
    status: KeyHealthView | null;
    onClose: () => void;
    /** Resolves to an error to show, or null once saved. */
    onSave: (limits: KeyLimits) => Promise<string | null>;
}) {
    const t = useTranslations("components");
    const tcommon = useTranslations("common");
    const locale = useLocale();
    const [draft, setDraft] = useState<Draft>(() => draftOf(keyRow.limits));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const checked = limitsOfDraft(draft);
    const unchanged =
        checked.ok && JSON.stringify(checked.limits) === JSON.stringify(keyRow.limits);
    const spent: Partial<Record<(typeof KEY_LIMIT_FIELDS)[number], string>> = status
        ? {
              requestsPerDay: t("modelKeys.limits.usedToday", {
                  used: status.requestsToday.toLocaleString(locale)
              }),
              tokensPerDay: t("modelKeys.limits.usedToday", {
                  used: formatTokens(status.tokensToday, locale)
              }),
              tokensPerMonth: t("modelKeys.limits.usedMonth", {
                  used: formatTokens(status.tokensThisMonth, locale)
              })
          }
        : {};

    const submit = async () => {
        if (!checked.ok || busy) return;
        setBusy(true);
        setError(null);
        const refused = await onSave(checked.limits);
        setBusy(false);
        if (refused) setError(refused);
    };

    return (
        <Dialog open onOpenChange={(next) => !next && !busy && onClose()}>
            <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto overscroll-contain">
                <DialogHeader>
                    <DialogTitle>{t("modelKeys.limits.title", { name: keyRow.name })}</DialogTitle>
                    <DialogDescription>{t("modelKeys.limits.hint")}</DialogDescription>
                </DialogHeader>
                <form
                    className="flex flex-col gap-4"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void submit();
                    }}
                >
                    {KEY_LIMIT_FIELDS.map((field) => {
                        const invalid = !checked.ok && checked.field === field;
                        return (
                            <label key={field} className="flex flex-col gap-1 text-sm">
                                <span className="flex min-w-0 items-baseline justify-between gap-2">
                                    <span className="min-w-0 truncate">
                                        {t(`modelKeys.limits.${field}`)}
                                    </span>
                                    {spent[field] ? (
                                        <span className="shrink-0 text-xs text-muted-foreground">
                                            {spent[field]}
                                        </span>
                                    ) : null}
                                </span>
                                <Input
                                    inputMode="numeric"
                                    value={draft[field]}
                                    placeholder={t("modelKeys.limits.none")}
                                    aria-invalid={invalid || undefined}
                                    onChange={(event) =>
                                        setDraft({ ...draft, [field]: event.target.value })
                                    }
                                />
                                {invalid ? (
                                    <span className="text-xs text-danger">
                                        {t("modelKeys.limits.invalid")}
                                    </span>
                                ) : null}
                            </label>
                        );
                    })}
                    {error ? (
                        <p className="text-sm text-danger" role="alert">
                            {error}
                        </p>
                    ) : null}
                    <div className="flex items-center justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
                            {tcommon("actions.cancel")}
                        </Button>
                        <Button type="submit" disabled={busy || !checked.ok || unchanged}>
                            {t("modelKeys.save")}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
