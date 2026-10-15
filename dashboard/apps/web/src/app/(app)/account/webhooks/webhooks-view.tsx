"use client";

/**
 * The account's signed webhooks: the list, adding one (its secret shown once),
 * which events each is sent, and each one's delivery log with Redeliver.
 */

import * as actions from "./actions";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { RelativeTime } from "@/components/relative-time";
import { DeliveryLogDialog } from "./delivery-log-dialog";
import { deliveryReason } from "./delivery-reason";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { OutboundHookView } from "@/lib/notifications/outbound-hooks";
import { MAX_OUTBOUND_WEBHOOKS, outboundWebhookInputSchema } from "@polaris/core";
import { KeyRound, ListChecks, Plus, ScrollText, Send, Trash2 } from "lucide-react";
import {
    Badge,
    Button,
    Card,
    CardBody,
    CardHeader,
    CardTitle,
    Checkbox,
    ConfirmDeleteDialog,
    CopyButton,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Switch
} from "@polaris/ui";

export interface EventOption {
    id: string;
    label: string;
    group: string;
}

type Open =
    | { kind: "add" }
    | { kind: "events"; hook: OutboundHookView }
    | { kind: "secret"; secret: string }
    | { kind: "rotate"; hook: OutboundHookView }
    | { kind: "remove"; hook: OutboundHookView }
    | { kind: "log"; hook: OutboundHookView }
    | null;

export function WebhooksView({ hooks, events }: { hooks: OutboundHookView[]; events: EventOption[] }) {
    const router = useRouter();
    const t = useTranslations("accountNotifications");
    const [open, setOpen] = useState<Open>(null);
    const [pending, startTransition] = useTransition();
    const [notice, setNotice] = useState<{ id: string; ok: boolean; text: string } | null>(null);
    const [dialogError, setDialogError] = useState<string | null>(null);
    // Switched here first and put back if the save fails.
    const [enabled, setEnabled] = useState<Record<string, boolean>>({});
    const atLimit = hooks.length >= MAX_OUTBOUND_WEBHOOKS;

    function toggle(hook: OutboundHookView, next: boolean) {
        setEnabled((current) => ({ ...current, [hook.id]: next }));
        startTransition(async () => {
            const result = await actions.setOutboundHookEnabledAction(hook.id, next);
            if (result.error) {
                setEnabled((current) => ({ ...current, [hook.id]: !next }));
                setNotice({ id: hook.id, ok: false, text: result.error });
                return;
            }
            router.refresh();
        });
    }

    function test(hook: OutboundHookView) {
        setNotice(null);
        startTransition(async () => {
            const result = await actions.testOutboundHookAction(hook.id);
            if (result.error) return setNotice({ id: hook.id, ok: false, text: result.error });
            const ok = result.status === "sent";
            const reason = result.delivery ? deliveryReason(t, result.delivery) : "";
            setNotice({
                id: hook.id,
                ok,
                text: ok ? t("webhooks.list.testSent") : t("webhooks.list.testFailed", { reason })
            });
        });
    }

    function close() {
        setOpen(null);
        setDialogError(null);
    }

    return (
        <Card>
            <CardHeader className="flex-row items-center justify-between gap-3">
                <div className="min-w-0">
                    <CardTitle>{t("webhooks.list.title")}</CardTitle>
                    {atLimit ? (
                        <p className="text-xs text-muted-foreground">
                            {t("webhooks.list.limit", { max: MAX_OUTBOUND_WEBHOOKS })}
                        </p>
                    ) : null}
                </div>
                <Button size="sm" variant="secondary" disabled={atLimit} onClick={() => setOpen({ kind: "add" })}>
                    <Plus className="size-4" />
                    {t("webhooks.list.add")}
                </Button>
            </CardHeader>
            <CardBody className="p-0">
                {hooks.length === 0 ? (
                    <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t("webhooks.list.empty")}</p>
                ) : (
                    <ul className="divide-y divide-border">
                        {hooks.map((hook) => {
                            const on = enabled[hook.id] ?? hook.enabled;
                            return (
                                <li key={hook.id} className="flex flex-col gap-1 px-4 py-3">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <div className="min-w-0 flex-1">
                                            <button
                                                type="button"
                                                onClick={() => setOpen({ kind: "log", hook })}
                                                className="block max-w-full truncate text-left text-sm font-medium hover:underline"
                                                title={hook.name}
                                            >
                                                {hook.name}
                                            </button>
                                            <p className="truncate text-xs text-muted-foreground" title={hook.urlHint}>
                                                {hook.urlHint} - {t("webhooks.list.eventCount", { count: hook.events.length })}
                                            </p>
                                        </div>
                                        <div className="flex shrink-0 items-center gap-1">
                                            {!on ? <Badge variant={hook.disabledReason ? "danger" : "neutral"}>{t("webhooks.list.off")}</Badge> : null}
                                            <Switch
                                                checked={on}
                                                disabled={pending}
                                                onChange={(next) => toggle(hook, next)}
                                                aria-label={on ? t("webhooks.list.switchOff") : t("webhooks.list.switchOn")}
                                            />
                                            <IconAction label={t("webhooks.list.test")} disabled={pending || !on} onClick={() => test(hook)}>
                                                <Send className="size-4" />
                                            </IconAction>
                                            <IconAction label={t("webhooks.list.log")} onClick={() => setOpen({ kind: "log", hook })}>
                                                <ScrollText className="size-4" />
                                            </IconAction>
                                            <IconAction label={t("webhooks.list.editEvents")} onClick={() => setOpen({ kind: "events", hook })}>
                                                <ListChecks className="size-4" />
                                            </IconAction>
                                            <IconAction label={t("webhooks.list.rotate")} onClick={() => setOpen({ kind: "rotate", hook })}>
                                                <KeyRound className="size-4" />
                                            </IconAction>
                                            <IconAction
                                                label={t("webhooks.list.remove")}
                                                danger
                                                onClick={() => setOpen({ kind: "remove", hook })}
                                            >
                                                <Trash2 className="size-4" />
                                            </IconAction>
                                        </div>
                                    </div>
                                    {hook.disabledReason && !on ? (
                                        <p className="text-xs text-danger">{t("webhooks.list.switchedOff")}</p>
                                    ) : null}
                                    {notice?.id === hook.id ? (
                                        <p className={notice.ok ? "text-xs text-success" : "text-xs text-danger"}>{notice.text}</p>
                                    ) : (
                                        <p className="text-xs text-muted-foreground">
                                            {hook.lastDeliveryAt
                                                ? t.rich("webhooks.list.lastDelivery", {
                                                      time: <RelativeTime key="time" iso={hook.lastDeliveryAt} />
                                                  })
                                                : t("webhooks.list.neverDelivered")}
                                        </p>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}
            </CardBody>

            {open?.kind === "add" ? (
                <EndpointDialog
                    events={events}
                    onClose={close}
                    onCreated={(secret) => {
                        setOpen({ kind: "secret", secret });
                        router.refresh();
                    }}
                />
            ) : null}
            {open?.kind === "events" ? (
                <EndpointDialog events={events} hook={open.hook} onClose={close} onCreated={close} />
            ) : null}
            {open?.kind === "secret" ? <SecretDialog secret={open.secret} onClose={close} /> : null}
            {open?.kind === "log" ? <DeliveryLogDialog hook={open.hook} onClose={close} /> : null}
            {open?.kind === "rotate" ? (
                <ConfirmDeleteDialog
                    open
                    onOpenChange={(next) => !next && close()}
                    name={open.hook.name}
                    requireTyping={false}
                    kind="webhook"
                    title={t("webhooks.rotate.title")}
                    question={t("webhooks.rotate.question", { name: open.hook.name })}
                    confirmLabel={t("webhooks.rotate.confirm")}
                    pending={pending}
                    error={dialogError}
                    onConfirm={() =>
                        startTransition(async () => {
                            const result = await actions.rotateOutboundHookSecretAction(open.hook.id);
                            if (!result.secret) return setDialogError(result.error ?? null);
                            setDialogError(null);
                            setOpen({ kind: "secret", secret: result.secret });
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
                    question={t("webhooks.remove.question", { name: open.hook.name })}
                    confirmLabel={t("webhooks.remove.confirm")}
                    pending={pending}
                    error={dialogError}
                    onConfirm={() =>
                        startTransition(async () => {
                            const result = await actions.deleteOutboundHookAction(open.hook.id);
                            if (result.error) return setDialogError(result.error);
                            close();
                            router.refresh();
                        })
                    }
                />
            ) : null}
        </Card>
    );
}

function IconAction({
    label,
    onClick,
    disabled,
    danger,
    children
}: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    danger?: boolean;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={onClick}
            className={`rounded p-1 text-muted-foreground transition-colors disabled:opacity-50 ${danger ? "hover:text-danger" : "hover:text-foreground"}`}
        >
            {children}
        </button>
    );
}

/** Adding an endpoint, or - given `hook` - changing which events it is sent. */
function EndpointDialog({
    events,
    hook,
    onClose,
    onCreated
}: {
    events: EventOption[];
    hook?: OutboundHookView;
    onClose: () => void;
    onCreated: (secret: string) => void;
}) {
    const router = useRouter();
    const t = useTranslations("accountNotifications");
    const tc = useTranslations("common");
    const [pending, startTransition] = useTransition();
    const [name, setName] = useState(hook?.name ?? "");
    const [url, setUrl] = useState("");
    const [picked, setPicked] = useState<Set<string>>(new Set(hook?.events ?? []));
    const [error, setError] = useState<string | null>(null);
    const groups = [...new Set(events.map((event) => event.group))];

    const checked = outboundWebhookInputSchema.safeParse({
        name: hook ? hook.name : name,
        url: hook ? "https://unchanged.invalid/" : url,
        events: [...picked]
    });
    const fieldError = (field: string): string | null => {
        if (checked.success) return null;
        const issue = checked.error.issues.find((entry) => entry.path[0] === field);
        // An empty field is not yet filled, not wrong.
        const empty = field === "name" ? !name.trim() : field === "url" ? !url.trim() : picked.size === 0;
        return issue && !empty ? issue.message : null;
    };
    const unchanged =
        hook !== undefined &&
        picked.size === hook.events.length &&
        hook.events.every((id) => picked.has(id));

    function flip(id: string, on: boolean) {
        setPicked((current) => {
            const next = new Set(current);
            if (on) next.add(id);
            else next.delete(id);
            return next;
        });
    }

    function submit() {
        if (!checked.success) return;
        setError(null);
        startTransition(async () => {
            if (hook) {
                const result = await actions.setOutboundHookEventsAction(hook.id, checked.data.events);
                if (result.error) return setError(result.error);
                router.refresh();
                onCreated("");
                return;
            }
            const result = await actions.createOutboundHookAction(checked.data);
            if (!result.secret) return setError(result.error ?? null);
            onCreated(result.secret);
        });
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{hook ? t("webhooks.form.editTitle", { name: hook.name }) : t("webhooks.form.title")}</DialogTitle>
                    <DialogDescription>
                        {hook ? t("webhooks.form.editDescription") : t("webhooks.form.description")}
                    </DialogDescription>
                </DialogHeader>
                <div className="flex min-w-0 flex-col gap-3">
                    {hook ? null : (
                        <>
                            <label className="flex flex-col gap-1 text-sm">
                                <span className="font-medium">{t("webhooks.form.name")} *</span>
                                <Input
                                    value={name}
                                    maxLength={60}
                                    onChange={(event) => setName(event.target.value)}
                                    placeholder={t("webhooks.form.namePlaceholder")}
                                />
                                {fieldError("name") ? <span className="text-xs text-danger">{fieldError("name")}</span> : null}
                            </label>
                            <label className="flex flex-col gap-1 text-sm">
                                <span className="font-medium">{t("webhooks.form.url")} *</span>
                                <Input
                                    value={url}
                                    type="url"
                                    inputMode="url"
                                    autoComplete="off"
                                    onChange={(event) => setUrl(event.target.value)}
                                    placeholder="https://example.com/hooks/polaris"
                                />
                                {fieldError("url") ? <span className="text-xs text-danger">{fieldError("url")}</span> : null}
                            </label>
                        </>
                    )}
                    <div className="flex flex-col gap-1 text-sm">
                        <div className="flex items-center justify-between gap-2">
                            <span className="font-medium">
                                {t("webhooks.form.events")} *{" "}
                                <span className="font-normal text-muted-foreground">
                                    ({t("webhooks.form.eventsPicked", { count: picked.size })})
                                </span>
                            </span>
                            <div className="flex shrink-0 gap-1">
                                <Button size="xs" variant="ghost" onClick={() => setPicked(new Set(events.map((e) => e.id)))}>
                                    {t("webhooks.form.selectAll")}
                                </Button>
                                <Button size="xs" variant="ghost" onClick={() => setPicked(new Set())}>
                                    {t("webhooks.form.selectNone")}
                                </Button>
                            </div>
                        </div>
                        <div className="max-h-64 overflow-y-auto overscroll-contain rounded-md border border-border p-2">
                            {groups.map((group) => (
                                <fieldset key={group} className="mb-2 last:mb-0">
                                    <legend className="text-xs font-medium text-muted-foreground">{group}</legend>
                                    {events
                                        .filter((event) => event.group === group)
                                        .map((event) => (
                                            <label key={event.id} className="flex min-w-0 items-center gap-2 py-0.5">
                                                <Checkbox
                                                    checked={picked.has(event.id)}
                                                    onChange={(change) => flip(event.id, change.target.checked)}
                                                />
                                                <span className="min-w-0 truncate" title={event.label}>
                                                    {event.label}
                                                </span>
                                            </label>
                                        ))}
                                </fieldset>
                            ))}
                        </div>
                    </div>
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onClose} disabled={pending}>
                            {tc("actions.cancel")}
                        </Button>
                        <Button onClick={submit} disabled={pending || !checked.success || unchanged}>
                            {hook ? t("webhooks.form.save") : t("webhooks.list.add")}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function SecretDialog({ secret, onClose }: { secret: string; onClose: () => void }) {
    const t = useTranslations("accountNotifications");
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("webhooks.secret.title")}</DialogTitle>
                    <DialogDescription>{t("webhooks.secret.description")}</DialogDescription>
                </DialogHeader>
                <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted px-3 py-2">
                    <code className="min-w-0 flex-1 break-all font-mono text-xs">{secret}</code>
                    <CopyButton value={secret} />
                </div>
                <p className="text-xs text-muted-foreground">{t("webhooks.secret.verify")}</p>
                <div className="flex justify-end">
                    <Button onClick={onClose}>{t("webhooks.secret.done")}</Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
