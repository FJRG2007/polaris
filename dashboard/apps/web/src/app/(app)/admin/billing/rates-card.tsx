"use client";

/**
 * The price card: a currency, and what each measured thing costs in it.
 *
 * Checked against the same schema the server saves with, as it is typed, so a
 * price that would be refused says so under its field before Save is pressed. A
 * blank price is not an error - it is "not charged" - and a card with every price
 * blank is not an error either, only not yet something to save.
 *
 * Saving shows the new card at once and puts the old one back if the server
 * refuses it.
 */

import { useMemo, useState } from "react";
import { runAction } from "@/lib/run-action";
import { Loader2, Trash2 } from "lucide-react";
import { useConfirm } from "@/components/confirm-dialog";
import { Button, Card, CardBody, Input, Select } from "@polaris/ui";
import { clearBillingRatesAction, saveBillingRatesAction } from "./actions";
import {
    BILLING_CURRENCIES,
    BILLING_RATE_KEYS,
    BILLING_RATE_LABELS,
    billingRatesInputSchema,
    type BillingRateKey,
    type BillingRates
} from "@polaris/core";

type Draft = { currency: string } & Record<BillingRateKey, string>;

/** The fields as a saved card fills them. */
function draftOf(rates: BillingRates | null): Draft {
    return {
        currency: rates?.currency ?? "EUR",
        cpuHour: rates?.cpuHour == null ? "" : String(rates.cpuHour),
        memoryGbHour: rates?.memoryGbHour == null ? "" : String(rates.memoryGbHour),
        storageGbMonth: rates?.storageGbMonth == null ? "" : String(rates.storageGbMonth),
        egressGb: rates?.egressGb == null ? "" : String(rates.egressGb)
    };
}

function sameRates(left: BillingRates | null, right: BillingRates | null): boolean {
    if (left === null || right === null) return left === right;
    return (
        left.currency === right.currency &&
        BILLING_RATE_KEYS.every((key) => left[key] === right[key])
    );
}

export function RatesCard({
    rates,
    onChange
}: {
    rates: BillingRates | null;
    onChange: () => void;
}) {
    const [saved, setSaved] = useState<BillingRates | null>(rates);
    const [draft, setDraft] = useState<Draft>(() => draftOf(rates));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [confirm, confirmDialog] = useConfirm();

    const parsed = useMemo(() => billingRatesInputSchema.safeParse(draft), [draft]);
    const blank = BILLING_RATE_KEYS.every((key) => draft[key].trim() === "");
    /** A field's own problem. The "set at least one" rule is the form's, and an
     *  empty card is incomplete rather than wrong, so it is not drawn as an error. */
    const problem = (key: BillingRateKey): string | null => {
        if (parsed.success || draft[key].trim() === "") return null;
        return parsed.error.issues.find((issue) => issue.path[0] === key)?.message ?? null;
    };
    const unchanged = parsed.success && sameRates(parsed.data, saved);

    const save = async () => {
        if (!parsed.success || unchanged) return;
        const previous = saved;
        setSaved(parsed.data);
        setBusy(true);
        setError("");
        const result = await runAction(() => saveBillingRatesAction(draft), setError);
        setBusy(false);
        if (!result || result.error) {
            setSaved(previous);
            if (result?.error) setError(result.error);
            return;
        }
        if (result.rates) {
            setSaved(result.rates);
            setDraft(draftOf(result.rates));
        }
        onChange();
    };

    const clear = async () => {
        const ok = await confirm({
            title: "Remove the prices?",
            description:
                "Every statement goes back to showing usage without money, and budgets stop being measured.",
            confirmLabel: "Remove prices",
            danger: true
        });
        if (!ok) return;
        const previous = saved;
        const previousDraft = draft;
        setSaved(null);
        setDraft(draftOf(null));
        setBusy(true);
        setError("");
        const result = await runAction(() => clearBillingRatesAction(), setError);
        setBusy(false);
        if (!result || result.error) {
            setSaved(previous);
            setDraft(previousDraft);
            if (result?.error) setError(result.error);
            return;
        }
        onChange();
    };

    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                        <h2 className="text-sm font-medium">Prices</h2>
                        <p className="text-muted-foreground text-xs">
                            {saved
                                ? "What each measured thing costs. Leave a price blank to not charge for it."
                                : "No prices are set, so statements show usage only. Set any of them to price it."}
                        </p>
                    </div>
                    <Select
                        aria-label="Currency"
                        className="w-48 shrink-0"
                        value={draft.currency}
                        onValueChange={(currency) => setDraft({ ...draft, currency })}
                        options={BILLING_CURRENCIES.map((entry) => ({
                            value: entry.code,
                            label: `${entry.code} - ${entry.label}`
                        }))}
                    />
                </div>

                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    {BILLING_RATE_KEYS.map((key) => {
                        const message = problem(key);
                        const id = `rate-${key}`;
                        return (
                            <div key={key} className="flex min-w-0 flex-col gap-1">
                                <label htmlFor={id} className="text-xs font-medium">
                                    {BILLING_RATE_LABELS[key].label}{" "}
                                    <span className="text-muted-foreground font-normal">
                                        {BILLING_RATE_LABELS[key].unit}
                                    </span>
                                </label>
                                <Input
                                    id={id}
                                    inputMode="decimal"
                                    autoComplete="off"
                                    placeholder="Not charged"
                                    value={draft[key]}
                                    aria-invalid={message ? true : undefined}
                                    aria-describedby={message ? `${id}-error` : undefined}
                                    onChange={(event) =>
                                        setDraft({ ...draft, [key]: event.target.value })
                                    }
                                />
                                {message ? (
                                    <p id={`${id}-error`} className="text-danger text-xs">
                                        {message}
                                    </p>
                                ) : null}
                            </div>
                        );
                    })}
                </div>

                {error ? <p className="text-danger text-sm">{error}</p> : null}

                <div className="flex flex-wrap items-center gap-2">
                    <Button
                        size="sm"
                        onClick={() => void save()}
                        disabled={busy || !parsed.success || unchanged}
                        aria-disabled={busy || !parsed.success || unchanged}
                    >
                        {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                        Save prices
                    </Button>
                    {saved ? (
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void clear()}
                            disabled={busy}
                        >
                            <Trash2 className="size-4" aria-hidden />
                            Remove prices
                        </Button>
                    ) : null}
                    {blank ? (
                        <p className="text-muted-foreground text-xs">
                            Set at least one price to save.
                        </p>
                    ) : null}
                </div>
            </CardBody>
            {confirmDialog}
        </Card>
    );
}
