"use client";

/**
 * The plans: how often a copy is taken, how many are kept, and where they go.
 *
 * Schedule and retention are one form because they are one decision. A schedule
 * with no retention rule is a disk that fills up, and a full disk is the outcome
 * backups exist to prevent - so the form cannot be saved without answering "and
 * then what", and the defaults answer it modestly rather than not at all.
 */

import { useState } from "react";
import { readReasonText, reasonFor } from "@/lib/read-json";
import { everyLabel } from "@/lib/backups/words";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { formatBytes } from "@polaris/core";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { deletePlanAction, savePlanAction } from "./actions";
import type { DestinationSummary, PlanSummary } from "./types";
import { BACKUP_EVERY_OPTIONS, MAX_KEEP_DAYS, MAX_KEEP_LAST } from "@/lib/backups/policy";
import {
    Badge,
    Button,
    Card,
    CardBody,
    ConfirmDeleteDialog,
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Skeleton,
    Switch
} from "@polaris/ui";

export function PlansPanel({
    plans,
    destinations,
    loading,
    onChanged
}: {
    plans: PlanSummary[];
    destinations: DestinationSummary[];
    loading: boolean;
    onChanged: () => Promise<void>;
}) {
    const t = useTranslations("backups");
    const tc = useTranslations("components");
    const [editing, setEditing] = useState<PlanSummary | "new" | null>(null);
    const [removing, setRemoving] = useState<PlanSummary | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Catches its own failure: an error thrown out of a Server Action is rethrown
    // in the React tree, where the boundary replaces the console with "This page
    // stopped working" rather than a line saying what refused.
    async function onDelete() {
        if (!removing) return;
        const target = removing;
        setRemoving(null);
        try {
            const result = await deletePlanAction(target.id);
            if (result.error) setError(result.error);
        } catch (caught) {
            setError(readReasonText(tc, reasonFor(caught)));
        }
        await onChanged();
    }

    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                    {t("plans.intro")}
                </p>
                <Button size="sm" onClick={() => setEditing("new")} disabled={destinations.length === 0}>
                    <Plus className="size-4" />
                    {t("plans.new")}
                </Button>
            </div>

            {error ? <p className="text-sm text-danger">{error}</p> : null}

            {loading ? (
                <div className="flex flex-col gap-2">
                    {Array.from({ length: 2 }, (_, index) => (
                        <Skeleton key={index} className="h-20 w-full" />
                    ))}
                </div>
            ) : plans.length === 0 ? (
                <Card>
                    <CardBody className="py-8 text-center text-sm text-muted-foreground">
                        {t("plans.none")}
                    </CardBody>
                </Card>
            ) : (
                <div className="grid gap-3 md:grid-cols-2">
                    {plans.map((plan) => (
                        <Card key={plan.id}>
                            <CardBody className="flex flex-col gap-2">
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                        <p className="truncate font-medium" title={plan.name}>{plan.name}</p>
                                        <p className="text-xs text-muted-foreground">
                                            {everyLabel(t, plan.every)}
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <Button size="sm" variant="ghost" onClick={() => setEditing(plan)}>
                                            {t("plans.edit")}
                                        </Button>
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            aria-label={t("plans.deleteNamed", { name: plan.name })}
                                            title={t("plans.delete")}
                                            onClick={() => setRemoving(plan)}
                                        >
                                            <Trash2 className="size-4" />
                                        </Button>
                                    </div>
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    {t("plans.keeps", {
                                        copies: plan.keepLast,
                                        days: plan.keepDays,
                                        capped: plan.maxBytes > 0 ? "yes" : "no",
                                        size: plan.maxBytes > 0 ? formatBytes(BigInt(plan.maxBytes)) : ""
                                    })}
                                </p>
                                <div className="flex flex-wrap items-center gap-1">
                                    {plan.destinationNames.map((name) => (
                                        <Badge key={name} variant="neutral">
                                            {name}
                                        </Badge>
                                    ))}
                                    <span className="ml-auto text-xs text-muted-foreground">
                                        {t("plans.usedBy", { count: plan.usedBy })}
                                    </span>
                                </div>
                            </CardBody>
                        </Card>
                    ))}
                </div>
            )}

            {editing ? (
                <PlanDialog
                    plan={editing === "new" ? null : editing}
                    destinations={destinations}
                    onClose={() => setEditing(null)}
                    onSaved={onChanged}
                />
            ) : null}

            {removing ? (
                <ConfirmDeleteDialog
                    open
                    onOpenChange={(open) => !open && setRemoving(null)}
                    name={removing.name}
                    kind={t("plans.kind")}
                    requireTyping={removing.usedBy > 0}
                    description={
                        removing.usedBy > 0
                            ? t("plans.deleteBody", { count: removing.usedBy })
                            : t("plans.deleteEmpty")
                    }
                    confirmLabel={t("plans.deleteConfirm")}
                    onConfirm={() => void onDelete()}
                />
            ) : null}
        </div>
    );
}

/** Gigabytes on screen, bytes in the column. */
function toGigabytes(bytes: number): string {
    return bytes > 0 ? String(Math.round((bytes / 1024 ** 3) * 100) / 100) : "";
}

function PlanDialog({
    plan,
    destinations,
    onClose,
    onSaved
}: {
    plan: PlanSummary | null;
    destinations: DestinationSummary[];
    onClose: () => void;
    onSaved: () => Promise<void>;
}) {
    const t = useTranslations("backups");
    const tc = useTranslations("components");
    const tcommon = useTranslations("common");
    const [name, setName] = useState(plan?.name ?? "");
    const [every, setEvery] = useState(plan?.every ?? "daily");
    const [keepLast, setKeepLast] = useState(String(plan?.keepLast ?? 7));
    const [keepDays, setKeepDays] = useState(String(plan?.keepDays ?? 0));
    const [maxGb, setMaxGb] = useState(toGigabytes(plan?.maxBytes ?? 0));
    const [notify, setNotify] = useState(plan?.notifyOnFailure ?? true);
    const [chosen, setChosen] = useState<string[]>(plan?.destinationIds ?? []);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Live, against the same rules the server enforces: a plan that writes
    // nowhere is a schedule that silently does nothing.
    const problems: string[] = [];
    if (!name.trim()) problems.push(t("plans.problems.name"));
    if (chosen.length === 0) problems.push(t("plans.problems.destination"));
    if (Number(keepLast) < 0 || Number(keepLast) > MAX_KEEP_LAST) problems.push(t("plans.problems.copies"));
    if (Number(keepDays) < 0 || Number(keepDays) > MAX_KEEP_DAYS) problems.push(t("plans.problems.days"));
    if (every !== "off" && Number(keepLast) === 0 && Number(keepDays) === 0 && !maxGb) {
        problems.push(t("plans.problems.limit"));
    }

    async function onSave() {
        setPending(true);
        setError(null);
        try {
            const result = await savePlanAction(
                {
                    name: name.trim(),
                    every,
                    keepLast: Number(keepLast) || 0,
                    keepDays: Number(keepDays) || 0,
                    maxBytes: maxGb ? Math.round(Number(maxGb) * 1024 ** 3) : 0,
                    notifyOnFailure: notify,
                    destinationIds: chosen
                },
                plan?.id
            );
            if (result.error) {
                setError(result.error);
                return;
            }
            await onSaved();
            onClose();
        } catch (caught) {
            setError(readReasonText(tc, reasonFor(caught)));
        } finally {
            setPending(false);
        }
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{plan ? t("plans.editNamed", { name: plan.name }) : t("plans.new")}</DialogTitle>
                    <DialogDescription>{t("plans.dialogIntro")}</DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("table.columns.name")}</span>
                        <Input
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder={t("plans.namePlaceholder")}
                        />
                    </label>

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("plans.take")}</span>
                        <Select
                            value={every}
                            onValueChange={setEvery}
                            aria-label={t("plans.howOften")}
                            options={BACKUP_EVERY_OPTIONS.map((option) => ({
                                value: option.value,
                                label: everyLabel(t, option.value)
                            }))}
                        />
                    </label>

                    <div className="grid gap-3 sm:grid-cols-3">
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">{t("plans.keep")}</span>
                            <Input
                                type="number"
                                min={0}
                                value={keepLast}
                                onChange={(event) => setKeepLast(event.target.value)}
                            />
                            <span className="text-xs text-muted-foreground">{t("plans.keepHint")}</span>
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">{t("plans.for")}</span>
                            <Input
                                type="number"
                                min={0}
                                value={keepDays}
                                onChange={(event) => setKeepDays(event.target.value)}
                            />
                            <span className="text-xs text-muted-foreground">{t("plans.forHint")}</span>
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">{t("plans.under")}</span>
                            <Input
                                type="number"
                                min={0}
                                step="0.1"
                                value={maxGb}
                                onChange={(event) => setMaxGb(event.target.value)}
                            />
                            <span className="text-xs text-muted-foreground">{t("plans.underHint")}</span>
                        </label>
                    </div>

                    <fieldset className="flex flex-col gap-1.5 text-sm">
                        <legend className="font-medium">{t("plans.goTo")}</legend>
                        <p className="text-xs text-muted-foreground">{t("plans.goToHint")}</p>
                        {destinations.map((destination) => (
                            <label key={destination.id} className="flex items-center gap-2">
                                <input
                                    type="checkbox"
                                    checked={chosen.includes(destination.id)}
                                    onChange={(event) =>
                                        setChosen((current) =>
                                            event.target.checked
                                                ? [...current, destination.id]
                                                : current.filter((entry) => entry !== destination.id)
                                        )
                                    }
                                />
                                <span>{destination.name}</span>
                                {destination.status === "unreachable" ? (
                                    <Badge variant="danger">{t("plans.notAnswering")}</Badge>
                                ) : null}
                            </label>
                        ))}
                    </fieldset>

                    <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3 text-sm">
                        <span>{t("plans.notify")}</span>
                        <Switch checked={notify} onChange={setNotify} aria-label={t("plans.notifyLabel")} />
                    </div>

                    {problems.length > 0 ? (
                        <p className="text-xs text-muted-foreground">{problems[0]}</p>
                    ) : null}
                    {error ? <p className="text-sm text-danger">{error}</p> : null}

                    <div className="flex justify-end gap-2">
                        <DialogClose asChild>
                            <Button variant="ghost">{tcommon("actions.cancel")}</Button>
                        </DialogClose>
                        <Button onClick={() => void onSave()} disabled={pending || problems.length > 0}>
                            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                            {plan ? t("plans.saveChanges") : t("plans.create")}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
