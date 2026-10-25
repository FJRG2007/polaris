"use client";

/**
 * Taking a message back, the same way from everywhere it can be asked for: the
 * hover row's menu, the right-click (or long-press) menu, and the delete key.
 *
 * Asked first, with the message itself on screen - who said it, when, and what
 * it says, drawn the way the conversation draws it - because "Delete this?"
 * over a 40-character excerpt is answered without being read. Holding Shift on
 * any of the three skips the question, for somebody clearing several in a row;
 * the dialog says so, with the key as this reader has it bound.
 *
 * Both routes end in the one `remove` below: the line becomes a tombstone at
 * once, and comes back with the reason if the server refuses.
 */

import * as actions from "./actions";
import * as core from "@polaris/core";
import { Avatar } from "@/components/avatar";
import { runAction } from "@/lib/run-action";
import { useAppUrl } from "@/components/app-url";
import { referenced } from "./message-references";
import type { SpaceEmojiScope } from "./space-emoji";
import { PersonName } from "@/components/person-name";
import { MessageTime } from "@/components/message-time";
import type { ChatMessageView } from "@/lib/chat/messages";
import { RichText } from "@/components/rich-text/rich-text";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import {
    ConfirmDeleteDialog,
    matchShortcut,
    useShortcutBindings,
    useShortcutText
} from "@polaris/ui";

/** Ask to delete a message. `immediately` is Shift held: no question. */
export type DeleteMessage = (message: ChatMessageView, immediately?: boolean) => void;

/** The delete shortcut pressed with Shift added - the same delete, unasked.
 *  Never true for a binding that already has Shift in it: that press is the
 *  plain shortcut, and asks. */
export function deleteKeyWithShift(event: KeyboardEvent): boolean {
    if (!event.shiftKey) return false;
    const plain = {
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: false
    };
    return matchShortcut(plain, ["chat.delete"]) === "chat.delete";
}

/** Everything a deleted message drops on screen. The server resolves the cards,
 *  previews and forwards from the text, and a tombstone has no text - so any of
 *  them left behind is this browser showing what the message said after it was
 *  taken back. */
const TOMBSTONE: Partial<ChatMessageView> = {
    body: "",
    deleted: true,
    reactions: [],
    attachments: [],
    references: [],
    invites: [],
    link: null,
    preview: null,
    previewPending: false,
    forwardable: false
};

export function useMessageDelete({
    setMessages,
    setError,
    leavesTrace,
    emoji = null,
    onDone
}: {
    setMessages: Dispatch<SetStateAction<readonly ChatMessageView[] | null>>;
    setError: (message: string) => void;
    /** The room keeps a line where a deleted message was. */
    leavesTrace: boolean;
    emoji?: SpaceEmojiScope | null;
    /** After the server has answered, either way. */
    onDone?: () => void | Promise<void>;
}): { request: DeleteMessage; dialog: ReactNode } {
    const [asking, setAsking] = useState<ChatMessageView | null>(null);

    const swap = (id: string, next: (entry: ChatMessageView) => ChatMessageView) =>
        setMessages(
            (current) => current?.map((entry) => (entry.id === id ? next(entry) : entry)) ?? current
        );

    const remove = async (message: ChatMessageView) => {
        swap(message.id, (entry) => ({ ...entry, ...TOMBSTONE }));
        const result = await runAction(() => actions.deleteMessageAction(message.id), setError);
        if (!result || result.error) {
            // Put back exactly what was there, reactions and cards included.
            swap(message.id, () => message);
            if (result?.error) setError(result.error);
        }
        await onDone?.();
    };

    const request: DeleteMessage = (message, immediately = false) => {
        if (message.deleted) return;
        if (immediately) void remove(message);
        else setAsking(message);
    };

    const dialog = (
        <DeleteMessageDialog
            message={asking}
            leavesTrace={leavesTrace}
            emoji={emoji}
            onOpenChange={(open) => !open && setAsking(null)}
            onConfirm={() => {
                const message = asking;
                setAsking(null);
                if (message) void remove(message);
            }}
        />
    );
    return { request, dialog };
}

export function DeleteMessageDialog({
    message,
    leavesTrace,
    emoji = null,
    onOpenChange,
    onConfirm
}: {
    /** Null closes it. */
    message: ChatMessageView | null;
    leavesTrace: boolean;
    emoji?: SpaceEmojiScope | null;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => void;
}) {
    const t = useTranslations("chat");
    return (
        <ConfirmDeleteDialog
            open={message !== null}
            onOpenChange={onOpenChange}
            name=""
            kind="message"
            requireTyping={false}
            title={t("deleteMessage.title")}
            description={t("deleteMessage.question")}
            // A line stays wherever the room keeps one, and always over replies:
            // a thread answering nothing is worse than one that admits it.
            question={
                leavesTrace || (message?.replyCount ?? 0) > 0
                    ? t("deleteMessage.leavesTrace")
                    : t("deleteMessage.noTrace")
            }
            note={<Protip />}
            confirmLabel={t("deleteMessage.delete")}
            onConfirm={onConfirm}
        >
            {message && <MessagePreview message={message} emoji={emoji} />}
        </ConfirmDeleteDialog>
    );
}

/** The message as the conversation draws it, without anything to press. */
function MessagePreview({
    message,
    emoji
}: {
    message: ChatMessageView;
    emoji: SpaceEmojiScope | null;
}) {
    const t = useTranslations("chat");
    const baseUrl = useAppUrl();
    const author = message.authorName ?? t("messageList.somebodyWhoHasLeft");
    const files = attachmentSummary(message, t);
    return (
        <div
            data-testid="delete-preview"
            className="flex max-h-60 min-w-0 gap-3 overflow-y-auto overscroll-contain rounded-md bg-muted/50 px-3 py-2.5"
        >
            <span className="shrink-0 pt-0.5">
                <Avatar person={{ id: message.authorId, name: author }} size={28} />
            </span>
            <div className="min-w-0 flex-1">
                <p className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate text-sm font-medium">
                        <PersonName id={message.authorId} name={author} />
                    </span>
                    <MessageTime
                        iso={message.createdAt}
                        className="whitespace-nowrap text-[0.6875rem] text-foreground-subtle"
                    />
                </p>
                {message.body && (
                    <div className="break-words text-sm">
                        <RichText
                            value={message.body}
                            origin={baseUrl}
                            references={referenced(message)}
                            customEmoji={emoji?.set ?? null}
                            flaggedLinks={message.flaggedLinks}
                        />
                    </div>
                )}
                {files && (
                    <p className="mt-1 truncate text-xs text-muted-foreground" title={files}>
                        {files}
                    </p>
                )}
            </div>
        </div>
    );
}

/** "2 images", or the one file's name - enough to tell which message this is. */
function attachmentSummary(
    message: ChatMessageView,
    t: ReturnType<typeof useTranslations>
): string | null {
    const files = message.attachments;
    if (files.length === 0) return null;
    if (files.every((file) => file.inline))
        return t("deleteMessage.images", { count: files.length });
    if (files.length === 1) return files[0]!.name;
    return t("deleteMessage.files", { count: files.length });
}

/** Discord's line: Shift with the click, and Shift with the key as bound. */
function Protip() {
    const t = useTranslations("chat");
    const keyText = useShortcutText();
    const bound = core.keysOf(useShortcutBindings(), "chat.delete")[0];
    // A key that already needs Shift has no Shift-held variant to offer.
    const withKey = bound && !core.bindingParts(bound).includes("Shift");
    const key = (chunks: ReactNode) => (
        <strong key="key" className="font-semibold text-foreground">
            {chunks}
        </strong>
    );
    const tip = (chunks: ReactNode) => (
        <span key="tip" className="font-semibold uppercase text-success">
            {chunks}
        </span>
    );
    return (
        <p data-testid="delete-protip" className="text-xs text-muted-foreground">
            {withKey
                ? t.rich("deleteMessage.protipKey", {
                      shift: keyText("Shift"),
                      combo: keyText(`Shift+${bound}`),
                      key,
                      tip
                  })
                : t.rich("deleteMessage.protip", { shift: keyText("Shift"), key, tip })}
        </p>
    );
}
