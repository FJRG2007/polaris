"use client";

/**
 * The open shelf's container registry logins: add, test, edit, remove.
 *
 * The page's heading paints at once; only the list waits, under rows shaped
 * like the ones it will hold, and the last answer seen paints before the fresh
 * one arrives. Secrets never come back from the server: an edit leaves the
 * field empty and an empty field keeps what is stored.
 */

import { RegistryDialog } from "./registry-dialog";
import { RegistryKindIcon } from "./registry-kind-icon";
import { useConfirm } from "@/components/confirm-dialog";
import { useCallback, useState, useTransition } from "react";
import { useLiveRead } from "@/components/use-live-resource";
import { Badge, Button, EmptyState, Skeleton } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { RegistryShelf, RegistryView } from "@/lib/registry-credential-service";
import { deleteRegistryAction, listRegistriesAction, testRegistryAction } from "../registry-actions";
import { CheckCircle2, CircleAlert, CircleDashed, Loader2, Package, Pencil, PlugZap, Plus, Trash2 } from "lucide-react";

type Shelf = RegistryShelf & { orgId: string | null };

export function RegistriesView() {
    const t = useTranslations("deployRegistries");
    const load = useCallback(async (): Promise<Shelf> => {
        const answer = await listRegistriesAction();
        if ("error" in answer) throw new Error(answer.error);
        return answer;
    }, []);
    const { data, error, replace } = useLiveRead<Shelf>({ load, cacheKey: "deploy.registries" });
    const [editing, setEditing] = useState<RegistryView | "new" | null>(null);
    const [rowError, setRowError] = useState<string | null>(null);
    const [testing, setTesting] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [confirm, confirmDialog] = useConfirm();

    const canManage = data?.canManage ?? false;
    const shelfNote = data ? (data.orgId ? t("shelf.org") : t("shelf.personal")) : null;

    function saved(registry: RegistryView) {
        if (!data) return;
        const others = data.registries.filter((entry) => entry.id !== registry.id);
        replace({ ...data, registries: [...others, registry].sort((a, b) => a.name.localeCompare(b.name)) });
    }

    async function remove(registry: RegistryView) {
        if (!data) return;
        const ok = await confirm({
            title: t("remove.title", { name: registry.name }),
            description: t("remove.description"),
            confirmLabel: t("remove.confirm"),
            danger: true
        });
        if (!ok) return;
        setRowError(null);
        const before = data;
        // Gone at once; back where it was if the server says no.
        replace({ ...data, registries: data.registries.filter((entry) => entry.id !== registry.id) });
        startTransition(async () => {
            const result = await deleteRegistryAction(registry.id);
            if (result.error) {
                replace(before);
                setRowError(result.error);
            }
        });
    }

    function test(registry: RegistryView) {
        if (!data) return;
        setRowError(null);
        setTesting(registry.id);
        startTransition(async () => {
            const answer = await testRegistryAction({ id: registry.id });
            setTesting(null);
            if (answer.error || !answer.result) {
                setRowError(answer.error ?? t("errors.testFailed"));
                return;
            }
            const current = data.registries.find((entry) => entry.id === registry.id);
            if (current) {
                saved({ ...current, lastTestedAt: new Date().toISOString(), lastTestOk: answer.result === "ok" });
            }
            if (answer.result !== "ok") setRowError(t(`test.${answer.result}`));
        });
    }

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3">
                <p className="min-w-0 flex-1 text-sm text-muted-foreground">
                    {shelfNote ?? <Skeleton className="h-4 w-64" />}
                </p>
                <Button
                    onClick={() => setEditing("new")}
                    disabled={!canManage}
                    title={data && !canManage ? t("cannotManage") : undefined}
                >
                    <Plus className="size-4" /> {t("add")}
                </Button>
            </div>
            {data && !canManage && <p className="text-sm text-muted-foreground">{t("cannotManage")}</p>}
            {rowError && (
                <p role="alert" className="text-sm text-danger">
                    {rowError}
                </p>
            )}

            {!data && error ? (
                <p role="alert" className="text-sm text-danger">
                    {error}
                </p>
            ) : !data ? (
                <ul className="flex flex-col gap-2" aria-busy="true" aria-label={t("loading")}>
                    {[0, 1, 2].map((index) => (
                        <li key={index} className="flex items-center gap-3 rounded-lg border border-border/60 px-4 py-3">
                            <Skeleton className="size-4" />
                            <Skeleton className="h-4 w-40" />
                            <Skeleton className="ml-auto h-4 w-24" />
                        </li>
                    ))}
                </ul>
            ) : data.registries.length === 0 ? (
                <EmptyState
                    icon={<Package className="size-6" />}
                    title={t("empty.title")}
                    description={canManage ? t("empty.description") : t("empty.readOnly")}
                />
            ) : (
                <ul className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto overscroll-contain">
                    {data.registries.map((registry) => (
                        <li
                            key={registry.id}
                            className="flex items-center gap-3 rounded-lg border border-border/60 px-4 py-3 text-sm"
                        >
                            <RegistryKindIcon kind={registry.kind} />
                            <div className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate font-medium" title={registry.name}>
                                    {registry.name}
                                </span>
                                <span
                                    className="truncate text-xs text-muted-foreground"
                                    title={`${registry.registry} - ${registry.username}`}
                                >
                                    {registry.registry} - {registry.username}
                                </span>
                            </div>
                            <TestBadge registry={registry} />
                            {canManage && (
                                <div className="flex shrink-0 items-center gap-1">
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        aria-label={t("test.button")}
                                        title={t("test.button")}
                                        disabled={pending}
                                        onClick={() => test(registry)}
                                    >
                                        {testing === registry.id ? (
                                            <Loader2 className="size-4 animate-spin" />
                                        ) : (
                                            <PlugZap className="size-4" />
                                        )}
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        aria-label={t("edit")}
                                        title={t("edit")}
                                        onClick={() => setEditing(registry)}
                                    >
                                        <Pencil className="size-4" />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        aria-label={t("remove.button")}
                                        title={t("remove.button")}
                                        disabled={pending}
                                        onClick={() => void remove(registry)}
                                    >
                                        <Trash2 className="size-4" />
                                    </Button>
                                </div>
                            )}
                        </li>
                    ))}
                </ul>
            )}

            {editing && (
                <RegistryDialog
                    registry={editing === "new" ? null : editing}
                    onClose={() => setEditing(null)}
                    onSaved={(registry) => {
                        saved(registry);
                        setEditing(null);
                    }}
                />
            )}
            {confirmDialog}
        </div>
    );
}

function TestBadge({ registry }: { registry: RegistryView }) {
    const t = useTranslations("deployRegistries");
    if (registry.lastTestOk === null) {
        return (
            <Badge className="hidden shrink-0 gap-1 sm:inline-flex">
                <CircleDashed className="size-3" /> {t("status.untested")}
            </Badge>
        );
    }
    return registry.lastTestOk ? (
        <Badge variant="success" className="hidden shrink-0 gap-1 sm:inline-flex">
            <CheckCircle2 className="size-3" /> {t("status.ok")}
        </Badge>
    ) : (
        <Badge variant="danger" className="hidden shrink-0 gap-1 sm:inline-flex">
            <CircleAlert className="size-3" /> {t("status.failed")}
        </Badge>
    );
}
