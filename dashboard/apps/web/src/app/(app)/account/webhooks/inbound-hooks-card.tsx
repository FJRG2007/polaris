"use client";

/**
 * Deploy hooks: signed URLs that redeploy one service. Only services the account
 * may redeploy are offered; the secret is shown once, beside the URL.
 */

import * as actions from "./actions";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { RelativeTime } from "@/components/relative-time";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { InboundHookView, RedeployableService } from "@/lib/deploy/inbound-hooks";
import {
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    ConfirmDeleteDialog,
    CopyButton,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Switch
} from "@polaris/ui";

export function InboundHooksCard({
    hooks,
    services,
    baseUrl
}: {
    hooks: InboundHookView[];
    services: RedeployableService[];
    /** This Polaris's own address, so a copied URL never carries the tab's host. */
    baseUrl: string;
}) {
    const router = useRouter();
    const t = useTranslations("accountNotifications");
    const tc = useTranslations("common");
    const [pending, startTransition] = useTransition();
    const [adding, setAdding] = useState(false);
    const [created, setCreated] = useState<{ url: string; secret: string } | null>(null);
    const [removing, setRemoving] = useState<InboundHookView | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [enabled, setEnabled] = useState<Record<string, boolean>>({});
    const [name, setName] = useState("");
    const [serviceId, setServiceId] = useState("");
    const urlFor = (id: string) => `${baseUrl.replace(/\/+$/, "")}/api/hooks/in/${id}`;
    const ready = name.trim().length > 0 && serviceId !== "";

    function toggle(hook: InboundHookView, next: boolean) {
        setEnabled((current) => ({ ...current, [hook.id]: next }));
        startTransition(async () => {
            const result = await actions.setInboundHookEnabledAction(hook.id, next);
            if (result.error) {
                setEnabled((current) => ({ ...current, [hook.id]: !next }));
                setError(result.error);
                return;
            }
            router.refresh();
        });
    }

    function create() {
        setError(null);
        startTransition(async () => {
            const result = await actions.createInboundHookAction({ name: name.trim(), applicationId: serviceId });
            if (!result.hook || !result.secret) return setError(result.error ?? null);
            setAdding(false);
            setName("");
            setServiceId("");
            setCreated({ url: urlFor(result.hook.id), secret: result.secret });
            router.refresh();
        });
    }

    return (
        <Card>
            <CardHeader className="flex-row items-center justify-between gap-3">
                <div className="min-w-0">
                    <CardTitle>{t("webhooks.inbound.title")}</CardTitle>
                    <p className="text-xs text-muted-foreground">{t("webhooks.inbound.description")}</p>
                </div>
                <Button size="sm" variant="secondary" disabled={services.length === 0} onClick={() => setAdding(true)}>
                    <Plus className="size-4" />
                    {t("webhooks.inbound.add")}
                </Button>
            </CardHeader>
            <CardBody className="p-0">
                {hooks.length === 0 ? (
                    <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                        {services.length === 0 ? t("webhooks.inbound.noServices") : t("webhooks.inbound.empty")}
                    </p>
                ) : (
                    <ul className="divide-y divide-border">
                        {hooks.map((hook) => {
                            const on = enabled[hook.id] ?? hook.enabled;
                            return (
                                <li key={hook.id} className="flex flex-col gap-1 px-4 py-3">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate text-sm font-medium" title={hook.name}>
                                                {hook.name}
                                            </p>
                                            <p className="truncate text-xs text-muted-foreground">
                                                {t("webhooks.inbound.redeploys", { service: hook.serviceName })}
                                            </p>
                                        </div>
                                        <div className="flex shrink-0 items-center gap-1">
                                            <CopyButton value={urlFor(hook.id)} label={t("webhooks.inbound.url")} />
                                            <Switch
                                                checked={on}
                                                disabled={pending}
                                                onChange={(next) => toggle(hook, next)}
                                                aria-label={on ? t("webhooks.inbound.switchOff") : t("webhooks.inbound.switchOn")}
                                            />
                                            <button
                                                type="button"
                                                aria-label={t("webhooks.inbound.remove")}
                                                title={t("webhooks.inbound.remove")}
                                                onClick={() => setRemoving(hook)}
                                                className="rounded p-1 text-muted-foreground transition-colors hover:text-danger"
                                            >
                                                <Trash2 className="size-4" />
                                            </button>
                                        </div>
                                    </div>
                                    <p className="text-xs text-muted-foreground">
                                        {hook.lastUsedAt
                                            ? t.rich("webhooks.inbound.lastUsed", {
                                                  time: <RelativeTime key="time" iso={hook.lastUsedAt} />
                                              })
                                            : t("webhooks.inbound.neverUsed")}
                                    </p>
                                </li>
                            );
                        })}
                    </ul>
                )}
                {error && !adding && !removing ? <p className="px-4 pb-3 text-xs text-danger">{error}</p> : null}
            </CardBody>

            {adding ? (
                <Dialog open onOpenChange={(open) => !open && setAdding(false)}>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>{t("webhooks.inbound.dialogTitle")}</DialogTitle>
                            <DialogDescription>{t("webhooks.inbound.dialogDescription")}</DialogDescription>
                        </DialogHeader>
                        <div className="flex min-w-0 flex-col gap-3">
                            <label className="flex flex-col gap-1 text-sm">
                                <span className="font-medium">{t("webhooks.inbound.service")} *</span>
                                <Select
                                    value={serviceId}
                                    onValueChange={setServiceId}
                                    placeholder={t("webhooks.inbound.servicePlaceholder")}
                                    options={services.map((service) => ({
                                        value: service.id,
                                        label: `${service.project} / ${service.name}`
                                    }))}
                                />
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                                <span className="font-medium">{t("webhooks.inbound.name")} *</span>
                                <Input
                                    value={name}
                                    maxLength={60}
                                    onChange={(event) => setName(event.target.value)}
                                    placeholder={t("webhooks.inbound.namePlaceholder")}
                                />
                            </label>
                            {error ? <p className="text-sm text-danger">{error}</p> : null}
                            <div className="flex justify-end gap-2">
                                <Button variant="ghost" onClick={() => setAdding(false)} disabled={pending}>
                                    {tc("actions.cancel")}
                                </Button>
                                <Button onClick={create} disabled={pending || !ready}>
                                    {t("webhooks.inbound.add")}
                                </Button>
                            </div>
                        </div>
                    </DialogContent>
                </Dialog>
            ) : null}

            {created ? (
                <Dialog open onOpenChange={(open) => !open && setCreated(null)}>
                    <DialogContent>
                        <DialogHeader>
                            <DialogTitle>{t("webhooks.secret.title")}</DialogTitle>
                            <DialogDescription>{t("webhooks.secret.description")}</DialogDescription>
                        </DialogHeader>
                        <div className="flex min-w-0 flex-col gap-2">
                            <span className="text-xs font-medium">{t("webhooks.inbound.url")}</span>
                            <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted px-3 py-2">
                                <code className="min-w-0 flex-1 break-all font-mono text-xs">{created.url}</code>
                                <CopyButton value={created.url} />
                            </div>
                            <span className="text-xs font-medium">{t("webhooks.secret.title")}</span>
                            <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted px-3 py-2">
                                <code className="min-w-0 flex-1 break-all font-mono text-xs">{created.secret}</code>
                                <CopyButton value={created.secret} />
                            </div>
                            <p className="text-xs text-muted-foreground">{t("webhooks.inbound.secretVerify")}</p>
                        </div>
                        <div className="flex justify-end">
                            <Button onClick={() => setCreated(null)}>{t("webhooks.secret.done")}</Button>
                        </div>
                    </DialogContent>
                </Dialog>
            ) : null}

            {removing ? (
                <ConfirmDeleteDialog
                    open
                    onOpenChange={(next) => !next && setRemoving(null)}
                    name={removing.name}
                    requireTyping={false}
                    kind="webhook"
                    question={t("webhooks.inbound.removeQuestion", { name: removing.name })}
                    confirmLabel={t("webhooks.remove.confirm")}
                    pending={pending}
                    error={error}
                    onConfirm={() =>
                        startTransition(async () => {
                            const result = await actions.deleteInboundHookAction(removing.id);
                            if (result.error) return setError(result.error);
                            setRemoving(null);
                            router.refresh();
                        })
                    }
                />
            ) : null}
        </Card>
    );
}
