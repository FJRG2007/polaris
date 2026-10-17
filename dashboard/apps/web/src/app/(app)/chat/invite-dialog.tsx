"use client";

/**
 * Inviting friends into a space.
 *
 * Opening it is enough: a link with the defaults (a week, no limit) is made or
 * reused at once, pointing at the room it was opened from, so there is no step
 * between wanting to invite somebody and inviting them. The friends list sends
 * that link straight into the direct conversation with each person, from the
 * inviter, and the row turns into "Sent" without closing anything. Below it the
 * link itself, to copy, and "Edit invite link" for the bounds - saving those
 * makes a new link, because the old one may already have been handed out.
 */

import * as actions from "./actions";
import * as core from "@polaris/core";
import { useChat } from "./chat-context";
import { runAction } from "@/lib/run-action";
import { useAppUrl } from "@/components/app-url";
import { Avatar } from "@/components/avatar";
import type { ChatInviteView } from "@/lib/chat/invites";
import type { NamespaceKey } from "@/lib/i18n/types";
import type { ChatSpaceView } from "@/lib/chat/chat-service";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Check, Copy, Hash, Loader2, Search } from "lucide-react";
import type { ChatInviteCandidate } from "@/lib/chat/invites";
import { useEffect, useRef, useState } from "react";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select
} from "@polaris/ui";

/** How long an invitation lasts, by its length in minutes. */
export const INVITE_DURATION_KEYS: Readonly<Record<number, NamespaceKey<"chat">>> = {
    30: "invite.durations.m30",
    60: "invite.durations.h1",
    360: "invite.durations.h6",
    720: "invite.durations.h12",
    1440: "invite.durations.d1",
    10080: "invite.durations.d7"
};

/** How long the copy button stays ticked. */
const COPIED_MS = 1600;
/** Pause after the last keystroke before the search is asked. */
const SEARCH_DEBOUNCE_MS = 200;

/** Where a person's row stands. */
type RowState = "idle" | "sending" | "sent";

export function InviteDialog({
    space,
    channelId = null,
    onOpenChange
}: {
    /** The space being invited into. Null closes it. */
    space: ChatSpaceView | null;
    /** The room it was opened from. Null: the space's first open room. */
    channelId?: string | null;
    onOpenChange: (open: boolean) => void;
}) {
    const t = useTranslations("chat");
    const baseUrl = useAppUrl();
    const { channels } = useChat();
    const [invite, setInvite] = useState<ChatInviteView | null>(null);
    const [error, setError] = useState("");
    const [query, setQuery] = useState("");
    const [people, setPeople] = useState<readonly ChatInviteCandidate[] | null>(null);
    const [rows, setRows] = useState<ReadonlyMap<string, RowState>>(new Map());
    const [copied, setCopied] = useState(false);
    const [editing, setEditing] = useState(false);
    const [expires, setExpires] = useState(String(core.INVITE_DEFAULT_MINUTES));
    const [uses, setUses] = useState(String(core.INVITE_DEFAULT_USES));
    const [saving, setSaving] = useState(false);
    const asked = useRef(0);

    const spaceId = space?.id ?? null;

    // The link, the moment the dialog opens.
    useEffect(() => {
        if (!spaceId) return;
        setInvite(null);
        setError("");
        setRows(new Map());
        setEditing(false);
        let live = true;
        void actions.inviteLinkAction({ spaceId, channelId }).then((result) => {
            if (!live) return;
            if (result.invite) setInvite(result.invite);
            else setError(result.error ?? t("errors.inviteNotMade"));
        });
        return () => {
            live = false;
        };
    }, [spaceId, channelId, t]);

    // The list: friends with nothing typed, the search with something.
    useEffect(() => {
        if (!spaceId) return;
        const ticket = ++asked.current;
        const timer = setTimeout(
            () => {
                void actions
                    .inviteCandidatesAction({ spaceId, query: query.trim() })
                    .then((result) => {
                        if (ticket !== asked.current) return;
                        setPeople(result.people ?? []);
                        if (result.error) setError(result.error);
                    });
            },
            query ? SEARCH_DEBOUNCE_MS : 0
        );
        return () => clearTimeout(timer);
    }, [spaceId, query]);

    useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(false), COPIED_MS);
        return () => clearTimeout(timer);
    }, [copied]);

    const link = invite ? `${baseUrl}/chat/i/${invite.code}` : "";
    const landing = channels.find((entry) => entry.id === (invite?.channelId ?? channelId)) ?? null;

    const send = async (person: ChatInviteCandidate) => {
        if (!invite || (rows.get(person.id) ?? "idle") !== "idle") return;
        // Optimistic: the row reads Sent at once and goes back if refused.
        setRows((current) => new Map(current).set(person.id, "sent"));
        setError("");
        const result = await runAction(
            () => actions.inviteToDirectAction({ code: invite.code, userId: person.id }),
            setError
        );
        if (!result || result.error) {
            setRows((current) => {
                const next = new Map(current);
                next.delete(person.id);
                return next;
            });
            if (result?.error) setError(result.error);
        }
    };

    const copy = async () => {
        if (!link) return;
        await navigator.clipboard?.writeText(link).catch(() => undefined);
        setCopied(true);
    };

    const regenerate = async () => {
        if (!spaceId) return;
        setSaving(true);
        setError("");
        const result = await runAction(
            () =>
                actions.createInviteAction({
                    spaceId,
                    ...((invite?.channelId ?? channelId)
                        ? { channelId: invite?.channelId ?? channelId }
                        : {}),
                    expiresMinutes: Number(expires),
                    maxUses: Number(uses)
                }),
            setError
        );
        setSaving(false);
        if (!result || result.error || !result.invite) {
            if (result?.error) setError(result.error);
            return;
        }
        setInvite(result.invite);
        // A new link is a new invitation: nobody has been sent this one yet.
        setRows(new Map());
        setEditing(false);
    };

    const expiry = expiryLine(invite, t);

    return (
        <Dialog open={space !== null} onOpenChange={onOpenChange}>
            <DialogContent className="flex max-h-[min(40rem,90dvh)] flex-col">
                <DialogHeader>
                    <DialogTitle className="truncate">
                        {editing
                            ? t("invite.linkSettings")
                            : t("invite.inviteFriendsTo", { name: space?.name ?? "" })}
                    </DialogTitle>
                    {!editing && (
                        <DialogDescription className="flex min-w-0 items-center gap-1">
                            {landing ? (
                                <>
                                    <span className="shrink-0">{t("invite.landsIn")}</span>
                                    <Hash className="size-3.5 shrink-0" />
                                    <span className="truncate font-medium text-foreground">
                                        {landing.name}
                                    </span>
                                </>
                            ) : (
                                t("invite.landsInSpace")
                            )}
                        </DialogDescription>
                    )}
                </DialogHeader>

                {editing ? (
                    <div className="flex flex-col gap-3">
                        <label className="flex flex-col gap-1">
                            <span className="text-xs font-medium text-muted-foreground">
                                {t("invite.expireAfter")}
                            </span>
                            <Select
                                value={expires}
                                onValueChange={setExpires}
                                options={[...core.INVITE_DURATIONS, core.INVITE_FOREVER].map(
                                    (minutes) => ({
                                        value: String(minutes),
                                        label:
                                            minutes === core.INVITE_FOREVER
                                                ? t("invite.durations.never")
                                                : t(
                                                      INVITE_DURATION_KEYS[minutes] ??
                                                          "invite.durations.never"
                                                  )
                                    })
                                )}
                            />
                        </label>
                        <label className="flex flex-col gap-1">
                            <span className="text-xs font-medium text-muted-foreground">
                                {t("invite.maxUses")}
                            </span>
                            <Select
                                value={uses}
                                onValueChange={setUses}
                                options={[core.INVITE_UNLIMITED, ...core.INVITE_USE_LIMITS].map(
                                    (limit) => ({
                                        value: String(limit),
                                        label:
                                            limit === core.INVITE_UNLIMITED
                                                ? t("invite.uses.unlimited")
                                                : t("invite.uses.count", { count: limit })
                                    })
                                )}
                            />
                        </label>
                        <DialogFooter>
                            <Button variant="ghost" onClick={() => setEditing(false)}>
                                {t("invite.cancel")}
                            </Button>
                            <Button disabled={saving} onClick={() => void regenerate()}>
                                {saving && <Loader2 className="size-4 animate-spin" />}
                                {t("invite.generateNewLink")}
                            </Button>
                        </DialogFooter>
                    </div>
                ) : (
                    <div className="flex min-h-0 flex-1 flex-col gap-3">
                        <div className="relative">
                            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                                placeholder={t("invite.searchFriends")}
                                aria-label={t("invite.searchFriends")}
                                className="pl-8"
                            />
                        </div>

                        <ul className="-mx-1 flex min-h-24 flex-1 flex-col overflow-y-auto px-1">
                            {people === null ? (
                                [0, 1, 2].map((at) => (
                                    <li
                                        key={at}
                                        className="flex items-center gap-3 px-1 py-2"
                                        aria-hidden
                                    >
                                        <span className="size-8 animate-pulse rounded-full bg-muted" />
                                        <span className="h-3 w-32 animate-pulse rounded bg-muted" />
                                    </li>
                                ))
                            ) : people.length === 0 ? (
                                <li className="px-1 py-6 text-center text-sm text-muted-foreground">
                                    {query.trim() ? t("invite.nobodyFound") : t("invite.noFriends")}
                                </li>
                            ) : (
                                people.map((person) => {
                                    const state = rows.get(person.id) ?? "idle";
                                    return (
                                        <li
                                            key={person.id}
                                            className="flex min-w-0 items-center gap-3 rounded-md px-1 py-1.5 hover:bg-card-hover"
                                        >
                                            <Avatar
                                                person={{ id: person.id, name: person.name }}
                                                size={32}
                                            />
                                            <span className="flex min-w-0 flex-1 flex-col">
                                                <span
                                                    className="truncate text-sm font-medium"
                                                    title={person.name}
                                                >
                                                    {person.name}
                                                </span>
                                                {person.username && (
                                                    <span className="truncate text-xs text-muted-foreground">
                                                        @{person.username}
                                                    </span>
                                                )}
                                            </span>
                                            {person.member ? (
                                                <span className="shrink-0 text-xs text-muted-foreground">
                                                    {t("invite.alreadyMember")}
                                                </span>
                                            ) : (
                                                <Button
                                                    size="sm"
                                                    variant={
                                                        state === "sent" ? "ghost" : "secondary"
                                                    }
                                                    disabled={!invite || state !== "idle"}
                                                    onClick={() => void send(person)}
                                                    className="shrink-0"
                                                >
                                                    {state === "sent" ? (
                                                        <>
                                                            <Check className="size-4" />
                                                            {t("invite.sent")}
                                                        </>
                                                    ) : (
                                                        t("invite.invite")
                                                    )}
                                                </Button>
                                            )}
                                        </li>
                                    );
                                })
                            )}
                        </ul>

                        <div className="flex flex-col gap-1.5 border-t border-border pt-3">
                            <span className="text-xs font-semibold text-muted-foreground uppercase">
                                {t("invite.orSendLink")}
                            </span>
                            <div className="flex min-w-0 items-center gap-2">
                                <Input
                                    readOnly
                                    value={link}
                                    placeholder={t("invite.makingLink")}
                                    aria-label={t("invite.orSendLink")}
                                    onFocus={(event) => event.currentTarget.select()}
                                    className="min-w-0 flex-1 font-mono text-xs"
                                />
                                <Button
                                    size="sm"
                                    disabled={!link}
                                    onClick={() => void copy()}
                                    className="w-24 shrink-0"
                                >
                                    {copied ? (
                                        <Check className="size-4" />
                                    ) : (
                                        <Copy className="size-4" />
                                    )}
                                    {copied ? t("invite.copied") : t("invite.copy")}
                                </Button>
                            </div>
                            {invite && (
                                <p className="text-xs text-muted-foreground">
                                    {expiry}{" "}
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setExpires(String(core.INVITE_DEFAULT_MINUTES));
                                            setUses(String(core.INVITE_DEFAULT_USES));
                                            setEditing(true);
                                        }}
                                        className="font-medium text-primary hover:underline"
                                    >
                                        {t("invite.editLink")}
                                    </button>
                                </p>
                            )}
                        </div>
                    </div>
                )}

                {error && (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                )}
            </DialogContent>
        </Dialog>
    );
}

/** "Your invite link expires in 7 days." - or that it never does. */
function expiryLine(
    invite: ChatInviteView | null,
    t: ReturnType<typeof useTranslations<"chat">>
): string {
    if (!invite) return "";
    if (!invite.expiresAt) return t("invite.neverExpires");
    const left = Math.max(0, new Date(invite.expiresAt).getTime() - Date.now());
    const minutes = Math.round(left / 60_000);
    const when =
        minutes >= 60 * 24
            ? t("invite.left.days", { count: Math.round(minutes / (60 * 24)) })
            : minutes >= 60
              ? t("invite.left.hours", { count: Math.round(minutes / 60) })
              : t("invite.left.minutes", { count: Math.max(1, minutes) });
    return t("invite.expiresIn", { when });
}
