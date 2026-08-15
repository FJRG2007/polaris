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
import * as core from "@polaris/core";
import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import { useAppUrl } from "@/components/app-url";
import type { ChatInviteView } from "@/lib/chat/invites";
import type { ChatSpaceView } from "@/lib/chat/chat-service";
import { Check, Link2, Loader2, Send, X } from "lucide-react";
import { useDisplayFormat } from "@/components/display-format";
import { PeoplePicker, type PickedPerson } from "./people-picker";
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
                    <DialogTitle>Invite people</DialogTitle>
                    <DialogDescription>
                        Into {space?.name ?? "this space"}. Whoever accepts sees the channels a
                        member sees, and nothing that is private inside it.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                        <span className="text-sm font-medium">A link</span>
                        <div className="flex flex-wrap items-end gap-2">
                            <label className="flex min-w-32 flex-1 flex-col gap-1">
                                <span className="text-xs text-muted-foreground">Expires after</span>
                                <Select
                                    value={expires}
                                    onValueChange={setExpires}
                                    options={[...core.INVITE_DURATIONS, core.INVITE_FOREVER].map(
                                        (minutes) => ({
                                            value: String(minutes),
                                            label: core.INVITE_DURATION_LABELS[minutes] ?? ""
                                        })
                                    )}
                                />
                            </label>
                            <label className="flex min-w-32 flex-1 flex-col gap-1">
                                <span className="text-xs text-muted-foreground">Number of uses</span>
                                <Select
                                    value={uses}
                                    onValueChange={setUses}
                                    options={[core.INVITE_UNLIMITED, ...core.INVITE_USE_LIMITS].map(
                                        (limit) => ({
                                            value: String(limit),
                                            label: core.INVITE_USE_LABELS[limit] ?? ""
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
                                New link
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
                                    <span className="shrink-0 text-[11px] text-muted-foreground">
                                        {invite.maxUses === null
                                            ? `${invite.uses} used`
                                            : `${invite.uses}/${invite.maxUses}`}
                                        {invite.expiresAt
                                            ? ` - until ${format.dateTime(invite.expiresAt)}`
                                            : " - no end"}
                                    </span>
                                    <button
                                        type="button"
                                        aria-label="Copy this link"
                                        title="Copy this link"
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
                                        aria-label="Withdraw this invitation"
                                        title="Withdraw"
                                        onClick={async () => {
                                            await actions.revokeInviteAction(invite.id);
                                            setInvites((current) =>
                                                current.filter((entry) => entry.id !== invite.id)
                                            );
                                        }}
                                        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-danger/10 hover:text-danger"
                                    >
                                        <X className="size-3.5" />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}

                    <div className="flex flex-col gap-2 border-t border-border pt-4">
                        <span className="text-sm font-medium">Or send it to somebody here</span>
                        <PeoplePicker
                            label="Who to send it to"
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
                                    Sent to {sentTo}.
                                </span>
                            ) : (
                                "It arrives as a message in your conversation with them."
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
