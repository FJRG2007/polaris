"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Workflow } from "lucide-react";
import { useState, useTransition } from "react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Input,
    Select,
    Switch,
    Textarea,
    useToast
} from "@polaris/ui";
import * as core from "@polaris/core";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { LoadFailed, RowsSkeleton, StatusChip, useCachedAction, when } from "./shared";
import {
    creatableShelvesAction,
    createAutomationAction,
    listAutomationsAction,
    setEnabledAction
} from "./actions";

export function AutomationsList() {
    const t = useTranslations("automations");
    const locale = useLocale();
    const toast = useToast();
    const { data, error, refresh, replace } = useCachedAction(
        "polaris.automations.list",
        listAutomationsAction
    );
    const [creating, setCreating] = useState(false);

    const toggle = async (id: string, enabled: boolean) => {
        // Optimistic, rolled back when the server says no.
        replace((current) => ({
            ...current,
            rows: current.rows.map((row) => (row.id === id ? { ...row, enabled } : row))
        }));
        const answer = await setEnabledAction(id, enabled);
        if (!answer.ok) {
            replace((current) => ({
                ...current,
                rows: current.rows.map((row) =>
                    row.id === id ? { ...row, enabled: !enabled } : row
                )
            }));
            toast.show({ title: answer.error });
        }
    };

    return (
        <div className="space-y-4">
            <div className="flex justify-end">
                {data?.canEdit ? (
                    <Button onClick={() => setCreating(true)}>
                        <Plus aria-hidden="true" />
                        {t("newAutomation")}
                    </Button>
                ) : null}
            </div>
            {error !== null && !data ? (
                <LoadFailed
                    message={error || t("list.loadFailed")}
                    onRetry={() => void refresh()}
                />
            ) : !data ? (
                <RowsSkeleton />
            ) : data.rows.length === 0 ? (
                <EmptyState
                    icon={<Workflow aria-hidden="true" />}
                    title={t("list.emptyTitle")}
                    description={
                        data.canEdit ? t("list.emptyDescription") : t("list.emptyReadOnly")
                    }
                    action={
                        data.canEdit ? (
                            <Button onClick={() => setCreating(true)}>
                                <Plus aria-hidden="true" />
                                {t("newAutomation")}
                            </Button>
                        ) : undefined
                    }
                />
            ) : (
                <ul className="divide-y divide-border rounded-lg border border-border">
                    {data.rows.map((row) => (
                        <li key={row.id} className="flex items-center gap-3 p-3">
                            <div className="min-w-0 flex-1">
                                <Link
                                    href={`/automations/${row.id}`}
                                    className="block truncate font-medium hover:underline"
                                    title={row.name}
                                >
                                    {row.name}
                                </Link>
                                <p className="truncate text-xs text-muted-foreground">
                                    {t(
                                        `modes.${(core.AUTOMATION_MODES as readonly string[]).includes(row.mode) ? (row.mode as core.AutomationMode) : "single"}`
                                    )}
                                    {" - "}
                                    {row.lastRunAt
                                        ? t("list.lastRun", { when: when(row.lastRunAt, locale) })
                                        : t("list.never")}
                                </p>
                            </div>
                            {row.lastStatus ? <StatusChip status={row.lastStatus} /> : null}
                            {!row.published ? (
                                <span className="text-xs text-muted-foreground">
                                    {t("list.draft")}
                                </span>
                            ) : null}
                            <span title={row.published ? undefined : t("list.notPublished")}>
                                <Switch
                                    checked={row.enabled}
                                    disabled={!data.canEdit || !row.published}
                                    onChange={(next: boolean) => void toggle(row.id, next)}
                                    aria-label={t("list.switchLabel", { name: row.name })}
                                />
                            </span>
                        </li>
                    ))}
                </ul>
            )}
            {creating ? <CreateDialog onClose={() => setCreating(false)} /> : null}
        </div>
    );
}

function CreateDialog({ onClose }: { onClose: () => void }) {
    const t = useTranslations("automations");
    const router = useRouter();
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [orgId, setOrgId] = useState<string>("personal");
    const [error, setError] = useState<string | null>(null);
    const [pending, start] = useTransition();
    const shelves = useCachedAction("polaris.automations.shelves", creatableShelvesAction);
    const parsed = core.automationCreateSchema.safeParse({ name, description });

    const submit = () =>
        start(async () => {
            const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
            const answer = await createAutomationAction(
                { name, description, orgId: orgId === "personal" ? null : orgId },
                zone
            );
            if (!answer.ok) return setError(answer.error);
            router.push(`/automations/${answer.id}`);
        });

    const options = [
        { value: "personal", label: t("create.personal") },
        ...(shelves.data?.ok
            ? shelves.data.orgs.map((org) => ({ value: org.id, label: org.name }))
            : [])
    ];

    return (
        <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("create.title")}</DialogTitle>
                </DialogHeader>
                <form
                    className="space-y-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (parsed.success) submit();
                    }}
                >
                    <label className="block space-y-1 text-sm">
                        <span>{t("create.name")} *</span>
                        <Input
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder={t("create.namePlaceholder")}
                            maxLength={core.AUTOMATION_LIMITS.nameLength}
                            autoFocus
                        />
                    </label>
                    <label className="block space-y-1 text-sm">
                        <span>{t("create.descriptionLabel")}</span>
                        <Textarea
                            value={description}
                            onChange={(event) => setDescription(event.target.value)}
                            maxLength={core.AUTOMATION_LIMITS.descriptionLength}
                            rows={2}
                        />
                    </label>
                    {options.length > 1 ? (
                        <label className="block space-y-1 text-sm">
                            <span>{t("create.shelf")}</span>
                            <Select
                                value={orgId}
                                onValueChange={setOrgId}
                                options={options}
                                aria-label={t("create.shelf")}
                            />
                        </label>
                    ) : null}
                    {error ? (
                        <p role="alert" className="text-sm text-destructive">
                            {error}
                        </p>
                    ) : null}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            {t("create.cancel")}
                        </Button>
                        <Button
                            type="submit"
                            disabled={!parsed.success || pending}
                            aria-disabled={!parsed.success}
                        >
                            {t("create.submit")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
