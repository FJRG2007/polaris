"use client";

/**
 * The two sections of a channel's settings that make things rather than change
 * settings: invite links that open on the channel, and webhooks that post into
 * it. Both act at once - there is nothing to save afterwards.
 *
 * A webhook's address is shown once, the moment it is made or replaced: only a
 * hash of its secret is kept, so there is no "copy" for an old one, only "new
 * URL" - the same as an API key.
 */

import Link from "next/link";
import * as actions from "./actions";
import * as core from "@polaris/core";
import { useChat } from "./chat-context";
import { runAction } from "@/lib/run-action";
import { useAppUrl } from "@/components/app-url";
import { INVITE_DURATION_KEYS } from "./invite-dialog";
import { useCallback, useEffect, useState } from "react";
import type { ChatInviteView } from "@/lib/chat/invites";
import { useDisplayFormat } from "@/components/display-format";
import type { ChatChannelView } from "@/lib/chat/chat-service";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { ChatWebhookSecret, ChatWebhookView } from "@/lib/chat/webhooks";
import { Check, Copy, Link2, Loader2, Pencil, RefreshCw, Trash2, Webhook, X } from "lucide-react";
import { Button, cn, ConfirmDeleteDialog, EmptyState, Input, Select, Skeleton } from "@polaris/ui";

/** How long a copy button stays ticked. */
const COPIED_MS = 1600;

/** Where a webhook posts, on the deployment's own address. */
function webhookUrl(baseUrl: string, id: string, token: string): string {
    return `${baseUrl}/api/chat/webhooks/${id}/${token}`;
}

/** A copy that says it worked, for a moment. */
function useCopied(): [string, (key: string, text: string) => Promise<void>] {
    const [copied, setCopied] = useState("");
    useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(""), COPIED_MS);
        return () => clearTimeout(timer);
    }, [copied]);
    const copy = useCallback(async (key: string, text: string) => {
        await navigator.clipboard?.writeText(text).catch(() => undefined);
        setCopied(key);
    }, []);
    return [copied, copy];
}

export function InvitesSection({ channel }: { channel: ChatChannelView }) {
    const t = useTranslations("chat");
    const baseUrl = useAppUrl();
    const format = useDisplayFormat();
    const [invites, setInvites] = useState<readonly ChatInviteView[] | null>(null);
    const [expires, setExpires] = useState(String(core.INVITE_DURATIONS[4]));
    const [uses, setUses] = useState(String(core.INVITE_UNLIMITED));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [copied, copy] = useCopied();
    const linkFor = (code: string) => `${baseUrl}/chat/i/${code}`;

    useEffect(() => {
        if (!channel.spaceId || channel.private) return;
        let live = true;
        void actions.listInvitesAction(channel.spaceId, channel.id).then((result) => {
            if (!live) return;
            setInvites(result.invites ?? []);
            setError(result.error ?? "");
        });
        return () => {
            live = false;
        };
    }, [channel.spaceId, channel.id, channel.private]);

    // A private room is not opened by joining the space, so a link that lands
    // there would land on a refusal. Said, with the place that does let people
    // in, rather than a form that cannot work.
    if (channel.private) {
        return (
            <div className="flex flex-col items-start gap-3 rounded-lg border border-border px-3 py-3">
                <p className="text-sm text-muted-foreground">{t("channelSettings.invitesPrivate")}</p>
                <Button asChild size="sm" variant="secondary">
                    <Link href={`/chat/c/${channel.id}/settings/permissions`}>
                        {t("channelSettings.openPermissions")}
                    </Link>
                </Button>
            </div>
        );
    }

    const create = async () => {
        if (!channel.spaceId) return;
        setBusy(true);
        setError("");
        const result = await runAction(
            () =>
                actions.createInviteAction({
                    spaceId: channel.spaceId,
                    channelId: channel.id,
                    expiresMinutes: Number(expires),
                    maxUses: Number(uses)
                }),
            setError
        );
        setBusy(false);
        if (!result || result.error || !result.invite) {
            if (result?.error) setError(result.error);
            return;
        }
        const made = result.invite;
        setInvites((current) => [made, ...(current ?? [])]);
        await copy(made.id, linkFor(made.code));
    };

    const revoke = async (invite: ChatInviteView) => {
        const before = invites;
        setInvites((current) => (current ?? []).filter((entry) => entry.id !== invite.id));
        const result = await runAction(() => actions.revokeInviteAction(invite.id), setError);
        if (!result || result.error) {
            setInvites(before);
            if (result?.error) setError(result.error);
        }
    };

    return (
        <>
            <p className="text-sm text-muted-foreground">{t("channelSettings.invitesHint")}</p>

            <div className="flex flex-wrap items-end gap-2">
                <label className="flex min-w-32 flex-1 flex-col gap-1">
                    <span className="text-xs text-muted-foreground">{t("invite.expiresAfter")}</span>
                    <Select
                        value={expires}
                        onValueChange={setExpires}
                        aria-label={t("invite.expiresAfter")}
                        options={[...core.INVITE_DURATIONS, core.INVITE_FOREVER].map((minutes) => ({
                            value: String(minutes),
                            label: t(INVITE_DURATION_KEYS[minutes] ?? "invite.durations.never")
                        }))}
                    />
                </label>
                <label className="flex min-w-32 flex-1 flex-col gap-1">
                    <span className="text-xs text-muted-foreground">{t("invite.numberOfUses")}</span>
                    <Select
                        value={uses}
                        onValueChange={setUses}
                        aria-label={t("invite.numberOfUses")}
                        options={[core.INVITE_UNLIMITED, ...core.INVITE_USE_LIMITS].map((limit) => ({
                            value: String(limit),
                            label:
                                limit === core.INVITE_UNLIMITED
                                    ? t("invite.uses.unlimited")
                                    : t("invite.uses.count", { count: limit })
                        }))}
                    />
                </label>
                <Button size="sm" disabled={busy} onClick={() => void create()}>
                    {busy ? (
                        <Loader2 className="size-4 animate-spin" />
                    ) : (
                        <Link2 className="size-4" />
                    )}
                    {t("channelSettings.createLink")}
                </Button>
            </div>

            {invites === null ? (
                <div className="flex flex-col gap-2" aria-hidden="true">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                </div>
            ) : invites.length === 0 ? (
                <EmptyState icon={<Link2 />} title={t("channelSettings.noInvites")} />
            ) : (
                <div className="overflow-hidden rounded-lg border border-border">
                    {/* Discord's columns on a wide screen; each invite is a
                        two-line card on a phone, where four columns do not fit. */}
                    <div className="hidden grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_4rem_minmax(0,1fr)_4.5rem] gap-2 border-b border-border bg-card/40 px-3 py-1.5 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground md:grid">
                        <span>{t("channelSettings.columns.inviter")}</span>
                        <span>{t("channelSettings.columns.code")}</span>
                        <span>{t("channelSettings.columns.uses")}</span>
                        <span>{t("channelSettings.columns.expires")}</span>
                        <span />
                    </div>
                    <ul className="divide-y divide-border">
                        {invites.map((invite) => (
                            <li
                                key={invite.id}
                                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 px-3 py-2 text-sm md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_4rem_minmax(0,1fr)_4.5rem]"
                            >
                                <span className="min-w-0 truncate" title={invite.createdBy ?? ""}>
                                    {invite.createdBy ?? t("messageList.somebodyWhoHasLeft")}
                                </span>
                                <code
                                    className="col-start-1 row-start-2 min-w-0 truncate font-mono text-xs text-muted-foreground md:col-start-auto md:row-start-auto md:text-sm md:text-foreground"
                                    title={linkFor(invite.code)}
                                >
                                    {invite.code}
                                </code>
                                <span className="hidden tabular-nums md:block">
                                    {invite.maxUses === null
                                        ? invite.uses
                                        : `${invite.uses}/${invite.maxUses}`}
                                </span>
                                <span className="hidden min-w-0 truncate text-muted-foreground md:block">
                                    {invite.expiresAt
                                        ? format.dateTime(invite.expiresAt)
                                        : t("invite.durations.never")}
                                </span>
                                <span className="col-start-2 row-span-2 row-start-1 flex items-center justify-end gap-1 md:col-start-auto md:row-span-1 md:row-start-auto">
                                    <button
                                        type="button"
                                        onClick={() => void copy(invite.id, linkFor(invite.code))}
                                        aria-label={t("channelSettings.copyLink", { code: invite.code })}
                                        title={t("channelSettings.copyLink", { code: invite.code })}
                                        className="flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-card-hover hover:text-foreground"
                                    >
                                        {copied === invite.id ? (
                                            <Check className="size-3.5 shrink-0 text-success" />
                                        ) : (
                                            <Copy className="size-3.5 shrink-0" />
                                        )}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => void revoke(invite)}
                                        aria-label={t("channelSettings.revokeCode", { code: invite.code })}
                                        title={t("channelSettings.revokeCode", { code: invite.code })}
                                        className="flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-danger-soft hover:text-danger"
                                    >
                                        <X className="size-3.5 shrink-0" />
                                    </button>
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {error && (
                <p role="alert" className="text-sm text-danger">
                    {error}
                </p>
            )}
        </>
    );
}

export function WebhooksSection({ channel }: { channel: ChatChannelView }) {
    const t = useTranslations("chat");
    const baseUrl = useAppUrl();
    const format = useDisplayFormat();
    const { refresh } = useChat();
    const [hooks, setHooks] = useState<readonly ChatWebhookView[] | null>(null);
    /** The one address on screen right now, the moment after it was made. */
    const [revealed, setRevealed] = useState<{ id: string; url: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
    const [replacing, setReplacing] = useState<ChatWebhookView | null>(null);
    const [deleting, setDeleting] = useState<ChatWebhookView | null>(null);
    const [error, setError] = useState("");
    const [copied, copy] = useCopied();

    useEffect(() => {
        let live = true;
        void actions.listWebhooksAction(channel.id).then((result) => {
            if (!live) return;
            setHooks(result.webhooks ?? []);
            setError(result.error ?? "");
        });
        return () => {
            live = false;
        };
    }, [channel.id]);

    const reveal = (made: ChatWebhookSecret) => {
        setRevealed({ id: made.webhook.id, url: webhookUrl(baseUrl, made.webhook.id, made.token) });
    };

    const create = async () => {
        setBusy(true);
        setError("");
        const result = await runAction(
            () =>
                actions.createWebhookAction({
                    channelId: channel.id,
                    name: t("channelSettings.defaultWebhookName")
                }),
            setError
        );
        setBusy(false);
        if (!result || result.error || !result.created) {
            if (result?.error) setError(result.error);
            return;
        }
        const made = result.created;
        setHooks((current) => [...(current ?? []), made.webhook]);
        reveal(made);
    };

    const rename = async () => {
        if (!renaming) return;
        const name = renaming.name.trim();
        const parsed = core.chatWebhookRenameSchema.safeParse({ webhookId: renaming.id, name });
        if (!parsed.success) {
            setError(t("errors.webhookName"));
            return;
        }
        const before = hooks;
        setHooks((current) =>
            (current ?? []).map((hook) => (hook.id === renaming.id ? { ...hook, name } : hook))
        );
        setRenaming(null);
        const result = await runAction(() => actions.renameWebhookAction(parsed.data), setError);
        if (!result || result.error) {
            setHooks(before);
            if (result?.error) setError(result.error);
        }
    };

    return (
        <>
            <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                    <h2 className="text-sm font-semibold">{t("channelSettings.webhooks")}</h2>
                    <p className="text-sm text-muted-foreground">{t("channelSettings.webhooksHint")}</p>
                </div>
                <Button
                    size="sm"
                    disabled={busy || (hooks?.length ?? 0) >= core.MAX_CHAT_WEBHOOKS}
                    onClick={() => void create()}
                >
                    {busy ? <Loader2 className="size-4 animate-spin" /> : <Webhook className="size-4" />}
                    {t("channelSettings.newWebhook")}
                </Button>
            </div>

            {hooks === null ? (
                <div className="flex flex-col gap-2" aria-hidden="true">
                    <Skeleton className="h-14 w-full" />
                    <Skeleton className="h-14 w-full" />
                </div>
            ) : hooks.length === 0 ? (
                <EmptyState icon={<Webhook />} title={t("channelSettings.noWebhooks")} />
            ) : (
                <ul className="flex flex-col gap-2">
                    {hooks.map((hook) => (
                        <li key={hook.id} className="flex flex-col gap-2 rounded-lg border border-border px-3 py-3">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                                    <Webhook className="size-4 shrink-0" />
                                </span>
                                {renaming?.id === hook.id ? (
                                    <form
                                        className="flex min-w-0 flex-1 items-center gap-2"
                                        onSubmit={(event) => {
                                            event.preventDefault();
                                            void rename();
                                        }}
                                    >
                                        <Input
                                            autoFocus
                                            value={renaming.name}
                                            maxLength={core.MAX_CHAT_WEBHOOK_NAME}
                                            aria-label={t("channelSettings.webhookName")}
                                            aria-invalid={renaming.name.trim() ? undefined : true}
                                            onChange={(event) =>
                                                setRenaming({ id: hook.id, name: event.target.value })
                                            }
                                            onKeyDown={(event) => {
                                                if (event.key === "Escape") {
                                                    event.preventDefault();
                                                    setRenaming(null);
                                                }
                                            }}
                                        />
                                        <Button type="submit" size="sm" disabled={!renaming.name.trim()}>
                                            {t("channelSettings.save")}
                                        </Button>
                                    </form>
                                ) : (
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm font-medium" title={hook.name}>
                                            {hook.name}
                                        </p>
                                        <p className="truncate text-xs text-muted-foreground">
                                            {[
                                                hook.createdBy
                                                    ? t("channelSettings.madeBy", { name: hook.createdBy })
                                                    : null,
                                                hook.lastUsedAt
                                                    ? t("channelSettings.lastUsed", {
                                                          when: format.dateTime(hook.lastUsedAt)
                                                      })
                                                    : t("channelSettings.neverUsed")
                                            ]
                                                .filter(Boolean)
                                                .join(" - ")}
                                        </p>
                                    </div>
                                )}
                                {renaming?.id !== hook.id && (
                                    <span
                                        className="flex shrink-0 items-center gap-1"
                                        role="group"
                                        aria-label={t("channelSettings.webhookActions", { name: hook.name })}
                                    >
                                        <IconButton
                                            label={t("channelSettings.rename")}
                                            onClick={() => setRenaming({ id: hook.id, name: hook.name })}
                                        >
                                            <Pencil className="size-3.5 shrink-0" />
                                        </IconButton>
                                        <IconButton
                                            label={t("channelSettings.newUrl")}
                                            onClick={() => setReplacing(hook)}
                                        >
                                            <RefreshCw className="size-3.5 shrink-0" />
                                        </IconButton>
                                        <IconButton
                                            label={t("channelSettings.deleteWebhook")}
                                            danger
                                            onClick={() => setDeleting(hook)}
                                        >
                                            <Trash2 className="size-3.5 shrink-0" />
                                        </IconButton>
                                    </span>
                                )}
                            </div>

                            {revealed?.id === hook.id && (
                                <div className="flex flex-col gap-1.5 rounded-md border border-warning-edge bg-warning-soft px-2.5 py-2">
                                    <p className="text-xs text-warning-ink">{t("channelSettings.urlOnce")}</p>
                                    <div className="flex items-center gap-2">
                                        <code className="min-w-0 flex-1 truncate font-mono text-xs" title={revealed.url}>
                                            {revealed.url}
                                        </code>
                                        <Button
                                            size="sm"
                                            variant="secondary"
                                            onClick={() => void copy(hook.id, revealed.url)}
                                        >
                                            {copied === hook.id ? (
                                                <Check className="size-4 text-success" />
                                            ) : (
                                                <Copy className="size-4" />
                                            )}
                                            {copied === hook.id
                                                ? t("channelSettings.copied")
                                                : t("channelSettings.copyUrl")}
                                        </Button>
                                    </div>
                                </div>
                            )}
                        </li>
                    ))}
                </ul>
            )}

            {error && (
                <p role="alert" className="text-sm text-danger">
                    {error}
                </p>
            )}

            <ConfirmDeleteDialog
                open={replacing !== null}
                onOpenChange={(open) => !open && setReplacing(null)}
                name={replacing?.name ?? ""}
                kind="webhook"
                requireTyping={false}
                title={t("channelSettings.newUrlTitle")}
                question={t("channelSettings.newUrlHint")}
                confirmLabel={t("channelSettings.newUrl")}
                onConfirm={async () => {
                    const hook = replacing;
                    if (!hook) return;
                    const result = await runAction(() => actions.resetWebhookAction(hook.id), setError);
                    setReplacing(null);
                    if (!result || result.error || !result.created) {
                        if (result?.error) setError(result.error);
                        return;
                    }
                    reveal(result.created);
                }}
            />
            <ConfirmDeleteDialog
                open={deleting !== null}
                onOpenChange={(open) => !open && setDeleting(null)}
                name={deleting?.name ?? ""}
                kind="webhook"
                requireTyping={false}
                description={t("channelSettings.deleteWebhookHint")}
                confirmLabel={t("channelSettings.deleteWebhook")}
                onConfirm={async () => {
                    const hook = deleting;
                    if (!hook) return;
                    const before = hooks;
                    setHooks((current) => (current ?? []).filter((entry) => entry.id !== hook.id));
                    setDeleting(null);
                    const result = await runAction(() => actions.deleteWebhookAction(hook.id), setError);
                    if (!result || result.error) {
                        setHooks(before);
                        if (result?.error) setError(result.error);
                        return;
                    }
                    if (revealed?.id === hook.id) setRevealed(null);
                    refresh();
                }}
            />
        </>
    );
}

function IconButton({
    label,
    danger = false,
    onClick,
    children
}: {
    label: string;
    danger?: boolean;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-label={label}
            title={label}
            className={cn(
                "flex size-8 items-center justify-center rounded text-muted-foreground",
                danger ? "hover:bg-danger-soft hover:text-danger" : "hover:bg-card-hover hover:text-foreground"
            )}
        >
            {children}
        </button>
    );
}
