"use client";

import { useState, useTransition } from "react";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import {
    Button,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Input,
    Select,
    useToast
} from "@polaris/ui";
import * as core from "@polaris/core";
import type { SecretSummary } from "@/lib/automations/secrets";
import { LoadFailed, RowsSkeleton, useCachedAction, when } from "../shared";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { createSecretAction, deleteSecretAction, listSecretsAction } from "../actions";

export function SecretsView() {
    const t = useTranslations("automations");
    const locale = useLocale();
    const toast = useToast();
    const { data, error, refresh, replace } = useCachedAction("polaris.automations.secrets", listSecretsAction);
    const [creating, setCreating] = useState(false);
    const [removing, setRemoving] = useState<SecretSummary | null>(null);
    const [pending, start] = useTransition();

    const remove = (secret: SecretSummary) =>
        start(async () => {
            // Optimistic, put back when the server says no.
            replace((current) => ({ ...current, rows: current.rows.filter((row) => row.id !== secret.id) }));
            setRemoving(null);
            const answer = await deleteSecretAction(secret.id);
            if (!answer.ok) {
                toast.show({ title: answer.error });
                return void refresh();
            }
            toast.show({ title: t("secrets.deleted") });
        });

    return (
        <div className="space-y-4">
            {data?.canEdit ? (
                <div className="flex justify-end">
                    <Button onClick={() => setCreating(true)}>
                        <Plus aria-hidden="true" />
                        {t("secrets.new")}
                    </Button>
                </div>
            ) : data ? (
                <p className="text-sm text-muted-foreground">{t("secrets.readOnly")}</p>
            ) : null}
            {error !== null && !data ? (
                <LoadFailed message={error || t("secrets.loadFailed")} onRetry={() => void refresh()} />
            ) : !data ? (
                <RowsSkeleton />
            ) : data.rows.length === 0 ? (
                <EmptyState
                    icon={<KeyRound aria-hidden="true" />}
                    title={t("secrets.empty")}
                    description={data.canEdit ? t("secrets.emptyHint") : undefined}
                    action={
                        data.canEdit ? (
                            <Button onClick={() => setCreating(true)}>
                                <Plus aria-hidden="true" />
                                {t("secrets.new")}
                            </Button>
                        ) : undefined
                    }
                />
            ) : (
                <ul className="divide-y divide-border rounded-lg border border-border">
                    {data.rows.map((row) => (
                        <li key={row.id} className="flex items-center gap-3 p-3">
                            <div className="min-w-0 flex-1">
                                <p className="truncate font-medium" title={row.name}>
                                    {row.name}
                                </p>
                                <p className="truncate text-xs text-muted-foreground">
                                    {t(`secrets.kinds.${row.kind}`)}
                                    {" - "}
                                    <code>{row.hint}</code>
                                    {" - "}
                                    {row.lastUsedAt ? t("secrets.lastUsed", { when: when(row.lastUsedAt, locale) }) : t("secrets.neverUsed")}
                                </p>
                            </div>
                            {data.canEdit ? (
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label={t("secrets.delete")}
                                    title={t("secrets.delete")}
                                    disabled={pending}
                                    onClick={() => setRemoving(row)}
                                >
                                    <Trash2 aria-hidden="true" />
                                </Button>
                            ) : null}
                        </li>
                    ))}
                </ul>
            )}
            {creating ? (
                <CreateDialog
                    onClose={() => setCreating(false)}
                    onCreated={(row) => {
                        replace((current) => ({ ...current, rows: [row, ...current.rows] }));
                        setCreating(false);
                        toast.show({ title: t("secrets.created") });
                    }}
                />
            ) : null}
            <ConfirmDeleteDialog
                open={removing !== null}
                onOpenChange={(open) => (!open ? setRemoving(null) : undefined)}
                name={removing?.name ?? ""}
                kind={t("secrets.title")}
                requireTyping={false}
                confirmLabel={t("secrets.delete")}
                pending={pending}
                onConfirm={() => (removing ? remove(removing) : undefined)}
            />
        </div>
    );
}

function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (row: SecretSummary) => void }) {
    const t = useTranslations("automations");
    const [name, setName] = useState("");
    const [kind, setKind] = useState<core.SecretKind>("url");
    const [value, setValue] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, start] = useTransition();
    const parsed = core.secretCreateSchema.safeParse({ name, kind, value });
    const valueCode = value.trim() && !parsed.success ? parsed.error.issues.find((issue) => issue.path[0] === "value")?.message : undefined;
    const valueIssue = valueCode === "urlInvalid" || valueCode === "basicInvalid" ? t(`errors.${valueCode}`) : null;

    const submit = () =>
        start(async () => {
            const answer = await createSecretAction({ name, kind, value });
            if (!answer.ok) return setError(answer.error);
            onCreated(answer.row);
        });

    return (
        <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("secrets.new")}</DialogTitle>
                </DialogHeader>
                <form
                    className="space-y-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (parsed.success) submit();
                    }}
                >
                    <label className="block space-y-1 text-sm">
                        <span>{t("secrets.name")} *</span>
                        <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("secrets.namePlaceholder")} maxLength={80} autoFocus />
                    </label>
                    <label className="block space-y-1 text-sm">
                        <span>{t("secrets.kind")}</span>
                        <Select
                            value={kind}
                            onValueChange={(next) => setKind(next as core.SecretKind)}
                            options={core.SECRET_KINDS.map((entry) => ({ value: entry, label: t(`secrets.kinds.${entry}`) }))}
                            aria-label={t("secrets.kind")}
                        />
                    </label>
                    <label className="block space-y-1 text-sm">
                        <span>{t("secrets.value")} *</span>
                        <Input
                            type="password"
                            autoComplete="off"
                            value={value}
                            onChange={(event) => setValue(event.target.value)}
                            placeholder={t(`secrets.valueHints.${kind}`)}
                            maxLength={core.AUTOMATION_LIMITS.secretLength}
                            aria-invalid={valueIssue ? true : undefined}
                        />
                        {valueIssue ? <span className="block text-xs text-destructive">{valueIssue}</span> : null}
                    </label>
                    {error ? (
                        <p role="alert" className="text-sm text-destructive">
                            {error}
                        </p>
                    ) : null}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            {t("create.cancel")}
                        </Button>
                        <Button type="submit" disabled={!parsed.success || pending} aria-disabled={!parsed.success}>
                            {t("secrets.create")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
