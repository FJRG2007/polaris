"use client";

/**
 * Inviting somebody into a space.
 *
 * Two ways, because they answer different questions. A link is for people you
 * are about to talk to somewhere else - it goes in an email, a ticket, a message
 * on another service - and it carries its own limits, since a link that can be
 * forwarded will be. Sending it to somebody here is for people who are already
 * in this Polaris, and it lands in the conversation you would have had with them
 * anyway rather than as a request they have to find.
 *
 * The two bounds are shown before the link is made rather than after. An invite
 * whose limits are chosen afterwards is one that existed unbounded for the
 * moment in between, and that moment is the whole of what a forwarded link needs.
 */

import * as actions from "./actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceKey } from "@/lib/i18n/types";

/** How long an invitation lasts, by its length in minutes. */
export const INVITE_DURATION_KEYS: Readonly<Record<number, NamespaceKey<"chat">>> = {
    30: "invite.durations.m30",
    60: "invite.durations.h1",
    360: "invite.durations.h6",
    720: "invite.durations.h12",
    1440: "invite.durations.d1",
    10080: "invite.durations.d7"
};
import * as core from "@polaris/core";
import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import { useAppUrl } from "@/components/app-url";
import type { ChatInviteView } from "@/lib/chat/invites";
import type { ChatSpaceView } from "@/lib/chat/chat-service";
import { Check, Link2, Loader2, Send, X } from "lucide-react";
import { useDisplayFormat } from "@/components/display-format";
import { PeoplePicker, type PickedPerson } from "@/components/people-picker";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Select
} from "@polaris/ui";

/** How long the copy button stays ticked. */
const COPIED_MS = 1600;

export function InviteDialog({
    space,
    onOpenChange
}: {
    /** The space being invited into. Null closes it. */
    space: ChatSpaceView | null;
    onOpenChange: (open: boolean) => void;
}) {
    const t = useTranslations("chat");
    const baseUrl = useAppUrl();
    const format = useDisplayFormat();
    const [expires, setExpires] = useState(String(core.INVITE_DURATIONS[4]));
    const [uses, setUses] = useState(String(core.INVITE_UNLIMITED));
    const [invites, setInvites] = useState<readonly ChatInviteView[]>([]);
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState("");
    const [sentTo, setSentTo] = useState("");
    const [error, setError] = useState("");

    useEffect(() => {
        if (!space) return;
        setError("");
        setSentTo("");
        void actions.listInvitesAction(space.id).then((result) => {
            setInvites(result.invites ?? []);
            setError(result.error ?? "");
        });
    }, [space]);

    useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(""), COPIED_MS);
        return () => clearTimeout(timer);
    }, [copied]);

    const linkFor = (code: string) => `${baseUrl}/chat/i/${code}`;

    const create = async () => {
        if (!space) return;
        setBusy(true);
        setError("");
        const result = await runAction(
            () =>
                actions.createInviteAction({
                    spaceId: space.id,
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
        setInvites((current) => [result.invite!, ...current]);
        await navigator.clipboard?.writeText(linkFor(result.invite.code)).catch(() => undefined);
        setCopied(result.invite.code);
    };

    const newest = invites.find((invite) => invite.usable) ?? null;

    return (
        <Dialog open={space !== null} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("invite.invitePeople")}</DialogTitle>
                    <DialogDescription>
                        {t("invite.into", { name: space?.name ?? t("invite.thisSpace") })}
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                        <span className="text-sm font-medium">{t("invite.aLink")}</span>
                        <div className="flex flex-wrap items-end gap-2">
                            <label className="flex min-w-32 flex-1 flex-col gap-1">
                                <span className="text-xs text-muted-foreground">
                                    {t("invite.expiresAfter")}
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
                            <label className="flex min-w-32 flex-1 flex-col gap-1">
                                <span className="text-xs text-muted-foreground">
                                    {t("invite.numberOfUses")}
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
                            <Button size="sm" disabled={busy} onClick={() => void create()}>
                                {busy ? (
                                    <Loader2 className="size-4 animate-spin" />
                                ) : (
                                    <Link2 className="size-4" />
                                )}
                                {t("invite.newLink")}
                            </Button>
                        </div>
                    </div>

                    {invites.length > 0 && (
                        <ul className="flex flex-col gap-1">
                            {invites.map((invite) => (
                                <li
                                    key={invite.id}
                                    className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5"
                                >
                                    <code className="min-w-0 flex-1 truncate font-mono text-xs">
                                        {linkFor(invite.code)}
                                    </code>
                                    <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
                                        {invite.maxUses === null
                                            ? t("invite.used", { count: invite.uses })
                                            : `${invite.uses}/${invite.maxUses}`}
                                        {invite.expiresAt
                                            ? t("invite.until", {
                                                  date: format.dateTime(invite.expiresAt)
                                              })
                                            : t("invite.noEnd")}
                                    </span>
                                    <button
                                        type="button"
                                        aria-label={t("invite.copyThisLink")}
                                        title={t("invite.copyThisLink")}
                                        onClick={async () => {
                                            await navigator.clipboard
                                                ?.writeText(linkFor(invite.code))
                                                .catch(() => undefined);
                                            setCopied(invite.code);
                                        }}
                                        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                    >
                                        {copied === invite.code ? (
                                            <Check className="size-3.5 text-success" />
                                        ) : (
                                            <Link2 className="size-3.5" />
                                        )}
                                    </button>
                                    <button
                                        type="button"
                                        aria-label={t("invite.withdrawThisInvitation")}
                                        title={t("invite.withdraw")}
                                        onClick={async () => {
                                            await actions.revokeInviteAction(invite.id);
                                            setInvites((current) =>
                                                current.filter((entry) => entry.id !== invite.id)
                                            );
                                        }}
                                        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-danger-soft hover:text-danger"
                                    >
                                        <X className="size-3.5" />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}

                    <div className="flex flex-col gap-2 border-t border-border pt-4">
                        <span className="text-sm font-medium">
                            {t("invite.orSendItToSomebody")}
                        </span>
                        <PeoplePicker
                            label={t("invite.whoToSendItTo")}
                            picked={[]}
                            max={1}
                            search={actions.searchPeopleAction}
                            onChange={async (picked: readonly PickedPerson[]) => {
                                const person = picked.at(-1);
                                if (!person || !newest) {
                                    if (!newest) setError("Make a link first.");
                                    return;
                                }
                                const result = await runAction(
                                    () =>
                                        actions.inviteToDirectAction({
                                            code: newest.code,
                                            userId: person.id,
                                            baseUrl
                                        }),
                                    setError
                                );
                                if (result && !result.error) setSentTo(person.name);
                            }}
                        />
                        <p className="text-xs text-muted-foreground">
                            {sentTo ? (
                                <span className="flex items-center gap-1 text-success">
                                    <Send className="size-3" />
                                    {t("invite.sentTo", { name: sentTo })}
                                </span>
                            ) : (
                                t("invite.itArrivesAsAMessage")
                            )}
                        </p>
                    </div>

                    {error && (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}
