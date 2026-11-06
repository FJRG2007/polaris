"use client";

/**
 * The parts of a meeting's invitations the list, the room and the New meeting
 * dialog all draw: the addresses field, the copied invitation, and who was asked.
 *
 * Polaris sends no mail of its own, so an address is recorded and shown as
 * invited, and the invitation is text the host copies - the link, and the join
 * code when there is one - to send however they already send things.
 */

import { Button, Input } from "@polaris/ui";
import { useAppUrl } from "@/components/app-url";
import { copyText } from "@/app/(app)/chat/links";
import { useState, type KeyboardEvent } from "react";
import type { MeetingSummary } from "@/lib/chat/meetings";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Check, ClipboardCopy, Mail, User, X } from "lucide-react";
import { MOST_EMAILS, formatJoinCode, inviteEmailSchema } from "@/lib/chat/meeting-invites";

/**
 * Addresses, typed one at a time and kept as chips. A comma, a space or Enter
 * takes what is in the box; a pasted list is split the same way. What does not
 * parse stays in the box with the reason under it rather than being dropped.
 */
export function EmailInvitesField({
    emails,
    onChange,
    draft,
    onDraftChange,
    disabledReason
}: {
    emails: readonly string[];
    onChange: (emails: readonly string[]) => void;
    /** What is typed and not yet a chip, held by the form so a create that
     *  follows straight on from typing still sends it. */
    draft: string;
    onDraftChange: (draft: string) => void;
    /** Why addresses cannot be added right now, which replaces the field. */
    disabledReason?: string;
}) {
    const t = useTranslations("chat");
    const [error, setError] = useState("");

    const take = (raw: string): boolean => {
        const parts = raw.split(/[\s,;]+/).filter(Boolean);
        if (parts.length === 0) return true;
        const next = [...emails];
        const rejected: string[] = [];
        for (const part of parts) {
            const parsed = inviteEmailSchema.safeParse(part);
            if (!parsed.success) rejected.push(part);
            else if (!next.includes(parsed.data)) next.push(parsed.data);
        }
        if (next.length > MOST_EMAILS) {
            setError(t("meetingInvites.tooManyEmails", { count: MOST_EMAILS }));
            return false;
        }
        onChange(next);
        onDraftChange(rejected.join(" "));
        setError(rejected.length > 0 ? t("meetingInvites.notAnEmail") : "");
        return rejected.length === 0;
    };

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter" || event.key === "," || event.key === " ") {
            if (!draft.trim()) return;
            event.preventDefault();
            take(draft);
        } else if (event.key === "Backspace" && !draft && emails.length > 0) {
            onChange(emails.slice(0, -1));
        }
    };

    return (
        <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">{t("meetingInvites.byEmail")}</span>
            {disabledReason ? (
                <p className="text-[0.6875rem] text-muted-foreground">{disabledReason}</p>
            ) : (
                <>
                    {emails.length > 0 && (
                        <ul className="flex flex-wrap gap-1.5">
                            {emails.map((email) => (
                                <li
                                    key={email}
                                    className="flex min-w-0 max-w-full items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs"
                                >
                                    <Mail className="size-3 shrink-0 text-muted-foreground" />
                                    <span className="min-w-0 truncate" title={email}>
                                        {email}
                                    </span>
                                    <button
                                        type="button"
                                        className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
                                        aria-label={t("meetingInvites.removeEmail", { email })}
                                        title={t("meetingInvites.removeEmail", { email })}
                                        onClick={() =>
                                            onChange(emails.filter((other) => other !== email))
                                        }
                                    >
                                        <X className="size-3 shrink-0" />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                    <Input
                        type="email"
                        value={draft}
                        autoComplete="off"
                        placeholder={t("meetingInvites.emailPlaceholder")}
                        aria-invalid={error ? true : undefined}
                        onChange={(event) => {
                            onDraftChange(event.target.value);
                            setError("");
                        }}
                        onKeyDown={onKeyDown}
                        onBlur={() => draft.trim() && take(draft)}
                        onPaste={(event) => {
                            const text = event.clipboardData.getData("text");
                            if (!/[\s,;]/.test(text.trim())) return;
                            event.preventDefault();
                            take(`${draft} ${text}`);
                        }}
                    />
                    <span
                        className={
                            error
                                ? "text-[0.6875rem] text-danger"
                                : "text-[0.6875rem] text-muted-foreground"
                        }
                        role={error ? "alert" : undefined}
                    >
                        {error || t("meetingInvites.emailHint")}
                    </span>
                </>
            )}
        </div>
    );
}

/**
 * What is still typed in the box, folded into the chips: the list a create
 * should send, or null when some of it is not an address.
 */
export function withDraft(emails: readonly string[], draft: string): string[] | null {
    const next = [...emails];
    for (const part of draft.split(/[\s,;]+/).filter(Boolean)) {
        const parsed = inviteEmailSchema.safeParse(part);
        if (!parsed.success) return null;
        if (!next.includes(parsed.data)) next.push(parsed.data);
    }
    return next;
}

/** The invitation as text, ready to paste into a mail or a message. */
export function useInvitationText(): (meeting: MeetingSummary) => string {
    const t = useTranslations("chat");
    const baseUrl = useAppUrl();
    const format = useDisplayFormat();
    return (meeting) => {
        const lines = [t("meetingInvites.textTitle", { meeting: meeting.title })];
        if (meeting.scheduledAt) {
            lines.push(
                t("meetingInvites.textWhen", { when: format.dateTime(meeting.scheduledAt) })
            );
        }
        if (meeting.guestToken) {
            lines.push(
                t("meetingInvites.textLink", { link: `${baseUrl}/m/${meeting.guestToken}` })
            );
        }
        if (meeting.joinCode) {
            lines.push(
                t("meetingInvites.textCode", {
                    page: `${baseUrl}/m`,
                    code: formatJoinCode(meeting.joinCode)
                })
            );
        }
        if (meeting.requireAccount) lines.push(t("meetingInvites.textAccount"));
        return lines.join("\n");
    };
}

/** Copy the invitation text. Only for the host, who is the only one holding the
 *  link and the code. */
export function CopyInvitationButton({ meeting }: { meeting: MeetingSummary }) {
    const t = useTranslations("chat");
    const text = useInvitationText();
    const [copied, setCopied] = useState(false);
    if (!meeting.mine || (!meeting.guestToken && !meeting.joinCode)) return null;
    return (
        <Button
            size="xs"
            variant="secondary"
            title={t("meetingInvites.copyInvitationHint")}
            onClick={async () => {
                await copyText(text(meeting));
                setCopied(true);
                window.setTimeout(() => setCopied(false), 2000);
            }}
        >
            {copied ? (
                <Check className="size-3.5 shrink-0" />
            ) : (
                <ClipboardCopy className="size-3.5 shrink-0" />
            )}
            {copied ? t("meetingInvites.copied") : t("meetingInvites.copyInvitation")}
        </Button>
    );
}

/** The join code as the host reads it out, with a copy of its own. */
export function JoinCodeBadge({ code }: { code: string }) {
    const t = useTranslations("chat");
    const [copied, setCopied] = useState(false);
    const shown = formatJoinCode(code);
    return (
        <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.6875rem] text-foreground hover:bg-muted/70"
            title={t("meetingInvites.copyCode")}
            aria-label={t("meetingInvites.copyCodeNamed", { code: shown })}
            onClick={async () => {
                await copyText(shown);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 2000);
            }}
        >
            {t("meetingInvites.code", { code: shown })}
            {copied && <Check className="size-3 shrink-0" />}
        </button>
    );
}

/** Who the host asked: people by name, then addresses, marked as invited. */
export function InvitedPeople({ meeting }: { meeting: MeetingSummary }) {
    const t = useTranslations("chat");
    if (!meeting.mine || (meeting.invited.length === 0 && meeting.invitedEmails.length === 0))
        return null;
    return (
        <div className="flex flex-col gap-1">
            <span className="text-[0.6875rem] font-medium text-muted-foreground">
                {t("meetingInvites.invited", {
                    count: meeting.invited.length + meeting.invitedEmails.length
                })}
            </span>
            <ul className="flex flex-wrap gap-1.5">
                {meeting.invited.map((person) => (
                    <li
                        key={person.id}
                        className="flex min-w-0 max-w-full items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs"
                    >
                        <User className="size-3 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 truncate" title={person.name}>
                            {person.name}
                        </span>
                    </li>
                ))}
                {meeting.invitedEmails.map((email) => (
                    <li
                        key={email}
                        className="flex min-w-0 max-w-full items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs"
                        title={t("meetingInvites.emailNotSent")}
                    >
                        <Mail className="size-3 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 truncate">{email}</span>
                    </li>
                ))}
            </ul>
        </div>
    );
}
