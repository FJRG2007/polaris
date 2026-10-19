"use client";

/**
 * Deploy hooks for one service, in its settings beside what they redeploy:
 * signed URLs your CI or registry posts to. The URL alone redeploys nothing -
 * every request is signed with a secret shown once, timestamped and accepted
 * once - and the secret can be replaced without changing the URL.
 */

import { SettingsCard } from "./settings-kit";
import * as actions from "./deploy-hook-actions";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { IconAction } from "@/components/icon-action";
import { RelativeTime } from "@/components/relative-time";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { InboundHookView } from "@/lib/deploy/inbound-hooks";
import { useCallback, useEffect, useState, useTransition } from "react";
import {
    Button,
    ConfirmDeleteDialog,
    CopyButton,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Skeleton,
    Switch
} from "@polaris/ui";

type Open =
    | { kind: "add" }
    | { kind: "secret"; url: string | null; secret: string }
    | { kind: "rotate"; hook: InboundHookView }
    | { kind: "remove"; hook: InboundHookView }
    | null;

export function DeployHooksCard({ applicationId }: { applicationId: string }) {
    const t = useTranslations("deployService");
    const [hooks, setHooks] = useState<InboundHookView[] | null>(null);
    const [others, setOthers] = useState<InboundHookView[]>([]);
    const [mayCreate, setMayCreate] = useState(false);
    const [max, setMax] = useState(0);
    const [baseUrl, setBaseUrl] = useState("");
    const [loadError, setLoadError] = useState<string | null>(null);
    const [open, setOpen] = useState<Open>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    // This Polaris's own address, so a copied URL never carries the tab's host.
    const urlFor = (id: string) => `${baseUrl.replace(/\/+$/, "")}/api/hooks/in/${id}`;

    const load = useCallback(async () => {
        setLoadError(null);
        const result = await actions.listDeployHooksAction(applicationId).catch(() => null);
        if (!result?.hooks) return setLoadError(result?.error ?? t("deployHooks.loadFailed"));
        setHooks(result.hooks);
        setOthers(result.others ?? []);
        setMayCreate(result.mayCreate === true);
        setMax(result.max ?? 0);
        setBaseUrl(result.baseUrl ?? "");
    }, [applicationId, t]);

    useEffect(() => {
        void load();
    }, [load]);

    function toggle(hook: InboundHookView, next: boolean) {
        // Switched here first and put back if the save fails.
        const flip = (enabled: boolean) =>
            setHooks(
                (current) =>
                    current?.map((entry) =>
                        entry.id === hook.id ? { ...entry, enabled } : entry
                    ) ?? null
            );
        flip(next);
        startTransition(async () => {
            const result = await actions.setDeployHookEnabledAction(hook.id, next);
            if (result.error) {
                flip(!next);
                setError(result.error);
            }
        });
    }

    const atLimit = hooks !== null && max > 0 && hooks.length + others.length >= max;
    const addRefusal = !mayCreate
        ? t("deployHooks.errors.forbidden")
        : atLimit
          ? t("deployHooks.errors.limit", { max })
          : undefined;

    function close() {
        setOpen(null);
        setError(null);
    }

    return (
        <SettingsCard
            title={t("deployHooks.title")}
            description={t("deployHooks.description")}
            actions={
                <Button
                    size="sm"
                    variant="secondary"
                    disabled={hooks === null || addRefusal !== undefined}
                    title={hooks === null ? undefined : addRefusal}
                    onClick={() => setOpen({ kind: "add" })}
                >
                    <Plus className="size-4" />
                    {t("deployHooks.add")}
                </Button>
            }
        >
            <p className="text-xs text-muted-foreground">{t("deployHooks.guard")}</p>
            {hooks !== null && addRefusal ? (
                <p className="text-xs text-muted-foreground">{addRefusal}</p>
            ) : null}
            {loadError ? (
                <div className="flex flex-wrap items-center gap-2 text-sm text-danger">
                    <span>{loadError}</span>
                    <Button size="xs" variant="ghost" onClick={() => void load()}>
                        {t("deployHooks.retry")}
                    </Button>
                </div>
            ) : hooks === null ? (
                <div className="flex flex-col gap-2">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                </div>
            ) : hooks.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("deployHooks.empty")}</p>
            ) : (
                <ul className="divide-y divide-border rounded-md border border-border">
                    {hooks.map((hook) => (
                        <li
                            key={hook.id}
                            className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                        >
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium" title={hook.name}>
                                    {hook.name}
                                </p>
                                <p className="truncate text-xs text-muted-foreground">
                                    {hook.lastUsedAt
                                        ? t.rich("deployHooks.lastUsed", {
                                              time: (
                                                  <RelativeTime key="time" iso={hook.lastUsedAt} />
                                              )
                                          })
                                        : t("deployHooks.neverUsed")}
                                </p>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                                <CopyButton value={urlFor(hook.id)} label={t("deployHooks.url")} />
                                <Switch
                                    checked={hook.enabled}
                                    disabled={pending}
                                    onChange={(next) => toggle(hook, next)}
                                    aria-label={
                                        hook.enabled
                                            ? t("deployHooks.switchOff")
                                            : t("deployHooks.switchOn")
                                    }
                                />
                                <IconAction
                                    label={t("deployHooks.rotate")}
                                    onClick={() => setOpen({ kind: "rotate", hook })}
                                >
                                    <KeyRound className="size-4" />
                                </IconAction>
                                <IconAction
                                    label={t("deployHooks.remove")}
                                    danger
                                    onClick={() => setOpen({ kind: "remove", hook })}
                                >
                                    <Trash2 className="size-4" />
                                </IconAction>
                            </div>
                        </li>
                    ))}
                </ul>
            )}
            {others.length > 0 ? (
                <div className="flex flex-col gap-1">
                    <p className="text-xs font-medium">{t("deployHooks.others")}</p>
                    <p className="text-xs text-muted-foreground">
                        {t("deployHooks.othersHint", { max })}
                    </p>
                    <ul className="divide-y divide-border rounded-md border border-border">
                        {others.map((hook) => (
                            <li
                                key={hook.id}
                                className="flex items-center justify-between gap-2 px-3 py-2"
                            >
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm" title={hook.name}>
                                        {hook.name}
                                    </p>
                                    <p
                                        className="truncate text-xs text-muted-foreground"
                                        title={hook.serviceName}
                                    >
                                        {hook.serviceName}
                                    </p>
                                </div>
                                <IconAction
                                    label={t("deployHooks.remove")}
                                    danger
                                    className="shrink-0"
                                    onClick={() => setOpen({ kind: "remove", hook })}
                                >
                                    <Trash2 className="size-4" />
                                </IconAction>
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}
            {error && open === null ? <p className="text-xs text-danger">{error}</p> : null}

            {open?.kind === "add" ? (
                <AddDialog
                    applicationId={applicationId}
                    onClose={close}
                    onCreated={(hook, secret) => {
                        setHooks((current) => [...(current ?? []), hook]);
                        setOpen({ kind: "secret", url: urlFor(hook.id), secret });
                    }}
                />
            ) : null}
            {open?.kind === "secret" ? (
                <SecretDialog url={open.url} secret={open.secret} onClose={close} />
            ) : null}
            {open?.kind === "rotate" ? (
                <ConfirmDeleteDialog
                    open
                    onOpenChange={(next) => !next && close()}
                    name={open.hook.name}
                    requireTyping={false}
                    kind="webhook"
                    title={t("deployHooks.rotateTitle")}
                    question={t("deployHooks.rotateQuestion", { name: open.hook.name })}
                    confirmLabel={t("deployHooks.rotateConfirm")}
                    pending={pending}
                    error={error}
                    onConfirm={() =>
                        startTransition(async () => {
                            const result = await actions.rotateDeployHookSecretAction(open.hook.id);
                            if (!result.secret) return setError(result.error ?? null);
                            setError(null);
                            setOpen({ kind: "secret", url: null, secret: result.secret });
                        })
                    }
                />
            ) : null}
            {open?.kind === "remove" ? (
                <ConfirmDeleteDialog
                    open
                    onOpenChange={(next) => !next && close()}
                    name={open.hook.name}
                    requireTyping={false}
                    kind="webhook"
                    question={t("deployHooks.removeQuestion", { name: open.hook.name })}
                    confirmLabel={t("deployHooks.removeConfirm")}
                    pending={pending}
                    error={error}
                    onConfirm={() =>
                        startTransition(async () => {
                            const result = await actions.deleteDeployHookAction(open.hook.id);
                            if (result.error) return setError(result.error);
                            setHooks(
                                (current) =>
                                    current?.filter((entry) => entry.id !== open.hook.id) ?? null
                            );
                            setOthers((current) =>
                                current.filter((entry) => entry.id !== open.hook.id)
                            );
                            close();
                        })
                    }
                />
            ) : null}
        </SettingsCard>
    );
}

function AddDialog({
    applicationId,
    onClose,
    onCreated
}: {
    applicationId: string;
    onClose: () => void;
    onCreated: (hook: InboundHookView, secret: string) => void;
}) {
    const t = useTranslations("deployService");
    const tc = useTranslations("common");
    const [name, setName] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function create() {
        setError(null);
        startTransition(async () => {
            const result = await actions.createDeployHookAction({
                name: name.trim(),
                applicationId
            });
            if (!result.hook || !result.secret) return setError(result.error ?? null);
            onCreated(result.hook, result.secret);
        });
    }

    return (
        <Dialog open onOpenChange={(next) => !next && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("deployHooks.dialogTitle")}</DialogTitle>
                    <DialogDescription>{t("deployHooks.dialogDescription")}</DialogDescription>
                </DialogHeader>
                <div className="flex min-w-0 flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("deployHooks.name")} *</span>
                        <Input
                            value={name}
                            maxLength={60}
                            onChange={(event) => setName(event.target.value)}
                            placeholder={t("deployHooks.namePlaceholder")}
                        />
                    </label>
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onClose} disabled={pending}>
                            {tc("actions.cancel")}
                        </Button>
                        <Button onClick={create} disabled={pending || name.trim() === ""}>
                            {t("deployHooks.add")}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function SecretDialog({
    url,
    secret,
    onClose
}: {
    url: string | null;
    secret: string;
    onClose: () => void;
}) {
    const t = useTranslations("deployService");
    return (
        <Dialog open onOpenChange={(next) => !next && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("deployHooks.secretTitle")}</DialogTitle>
                    <DialogDescription>{t("deployHooks.secretDescription")}</DialogDescription>
                </DialogHeader>
                <div className="flex min-w-0 flex-col gap-2">
                    {url ? (
                        <>
                            <span className="text-xs font-medium">{t("deployHooks.url")}</span>
                            <Value value={url} />
                        </>
                    ) : null}
                    <span className="text-xs font-medium">{t("deployHooks.secretTitle")}</span>
                    <Value value={secret} />
                    <p className="text-xs text-muted-foreground">{t("deployHooks.secretVerify")}</p>
                </div>
                <div className="flex justify-end">
                    <Button onClick={onClose}>{t("deployHooks.done")}</Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function Value({ value }: { value: string }) {
    return (
        <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted px-3 py-2">
            <code className="min-w-0 flex-1 break-all font-mono text-xs">{value}</code>
            <CopyButton value={value} />
        </div>
    );
}
