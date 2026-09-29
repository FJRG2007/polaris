"use client";

/**
 * What an administrator can change about a channel, reached by right-clicking it
 * in the list.
 *
 * The same three things the header offers - the name, what it is for, and
 * whether it is still open - plus deleting it, gathered in one place so a space
 * can be tidied without opening every channel in it first. That is the whole
 * point of a right-click on a rail: acting on a room you are not standing in.
 *
 * The name is normalized as it is typed, with the stored form shown underneath,
 * for the reason the new-channel dialog gives: "Release Planning" becoming
 * `release-planning` is a surprise once and an annoyance every time after.
 */

import * as actions from "./actions";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { spokenWait } from "@/lib/chat/durations";
import * as core from "@polaris/core";
import { useChat } from "./chat-context";
import { ShareDialog } from "@/components/access/share-dialog";
import { useRouter } from "next/navigation";
import { Hash, Loader2 } from "lucide-react";
import { runAction } from "@/lib/run-action";
import { useEffect, useMemo, useState } from "react";
import type { ChatChannelView } from "@/lib/chat/chat-service";
import {
    Button,
    cn,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select
} from "@polaris/ui";

export function ChannelSettingsDialog({
    channel,
    onOpenChange
}: {
    /** The channel being edited. Null closes it - one prop rather than a boolean
     *  beside it, so the two cannot disagree. */
    channel: ChatChannelView | null;
    onOpenChange: (open: boolean) => void;
}) {
    const t = useTranslations("chat");
    const router = useRouter();
    const { refresh } = useChat();
    const [name, setName] = useState("");
    const [topic, setTopic] = useState("");
    const [slowmode, setSlowmode] = useState(0);
    /** The voice room's limit as typed. Text rather than a number, so an emptied
     *  box reads as "no limit" instead of snapping back to a zero. */
    const [limitText, setLimitText] = useState("");
    const [busy, setBusy] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [error, setError] = useState("");
    /** Whether the sharing dialog is up over this one. */
    const [sharing, setSharing] = useState(false);

    // Reset each time a different channel is opened, so the dialog never shows
    // the last one's name for a frame.
    useEffect(() => {
        if (!channel) return;
        setName(channel.name);
        setTopic(channel.topic ?? "");
        setSlowmode(channel.slowmode);
        setLimitText(channel.userLimit > 0 ? String(channel.userLimit) : "");
        setError("");
    }, [channel]);

    const stored = useMemo(() => core.normalizeChannelName(name), [name]);
    const voice = channel?.kind === "voice";
    /** The limit, checked against the same rule the server applies. Empty is no
     *  limit, which is what most rooms want. */
    const limit = useMemo(() => {
        const typed = limitText.trim();
        return core.chatVoiceUserLimitSchema.safeParse(typed === "" ? 0 : Number(typed));
    }, [limitText]);
    const limitError = voice && !limit.success ? (limit.error.issues[0]?.message ?? "") : "";
    const userLimit = limit.success ? limit.data : null;
    const dirty =
        channel !== null &&
        (stored !== channel.name ||
            topic !== (channel.topic ?? "") ||
            slowmode !== channel.slowmode ||
            (voice && userLimit !== null && userLimit !== channel.userLimit));

    const save = async () => {
        if (!channel) return;
        setBusy(true);
        setError("");
        const result = await runAction(
            () =>
                actions.updateChannelAction({
                    channelId: channel.id,
                    name,
                    topic,
                    slowmode,
                    ...(voice && userLimit !== null ? { userLimit } : {})
                }),
            setError
        );
        setBusy(false);
        if (!result || result.error) return;
        onOpenChange(false);
        refresh();
    };

    return (
        <>
            <Dialog open={channel !== null} onOpenChange={onOpenChange}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t("channelSettings.channelSettings")}</DialogTitle>
                        <DialogDescription>
                            {channel?.archived
                                ? t("channelSettings.thisChannelIsArchivedIt")
                                : t("channelSettings.whatItIsCalledAnd")}
                        </DialogDescription>
                    </DialogHeader>

                    <div className="flex flex-col gap-3">
                        <div className="flex flex-col gap-1">
                            <Input
                                value={name}
                                autoFocus
                                aria-label={t("channelSettings.channelName")}
                                maxLength={80}
                                onChange={(event) => setName(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter" && stored && !busy) void save();
                                }}
                            />
                            {stored && stored !== name && (
                                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                                    <Hash className="size-3" />
                                    {stored}
                                </p>
                            )}
                        </div>

                        <Input
                            value={topic}
                            aria-label={t("channelSettings.whatItIsFor")}
                            placeholder={t("channelSettings.whatItIsForOptional")}
                            maxLength={core.MAX_CHAT_TOPIC}
                            onChange={(event) => setTopic(event.target.value)}
                        />

                        {/* How long between messages. A room stopping a hundred
                            people talking over each other, which is a different
                            thing from the instance's own limit on how fast
                            anything may be sent - that one exists to stop a
                            script. Whoever moderates the room is not held by
                            it. */}
                        <label className="flex flex-col gap-1">
                            <span className="text-[0.75rem] font-medium text-muted-foreground">
                                {t("channelSettings.waitBetweenMessages")}
                            </span>
                            <Select
                                value={String(slowmode)}
                                onValueChange={(value) => setSlowmode(Number(value))}
                                aria-label={t("channelSettings.waitBetweenMessages")}
                                options={core.CHAT_SLOWMODE_STEPS.map((seconds) => ({
                                    value: String(seconds),
                                    label: seconds === 0 ? t("channelSettings.off") : t(spokenWait(seconds).key, spokenWait(seconds).params)
                                }))}
                            />
                        </label>

                        {/* How many people the room holds at once. Somebody
                            walking into a full room is turned away with a
                            sentence that says so, and whoever moderates the
                            room is let in past it. */}
                        {voice && (
                            <label className="flex flex-col gap-1">
                                <span className="text-[0.75rem] font-medium text-muted-foreground">
                                    {t("channelSettings.userLimit")}
                                </span>
                                <Input
                                    value={limitText}
                                    inputMode="numeric"
                                    aria-label={t("channelSettings.userLimit")}
                                    aria-invalid={limitError ? true : undefined}
                                    placeholder={t("channelSettings.noLimit")}
                                    maxLength={2}
                                    onChange={(event) =>
                                        setLimitText(event.target.value.replace(/[^0-9]/g, ""))
                                    }
                                />
                                <span
                                    className={cn(
                                        "text-xs",
                                        limitError ? "text-danger" : "text-muted-foreground"
                                    )}
                                >
                                    {limitError ||
                                        t("channelSettings.limitHint", { max: core.MAX_VOICE_USER_LIMIT })}
                                </span>
                            </label>
                        )}

                        {/* A private room handed to a team or a role rather than
                            a person at a time - which is the whole of "the
                            support team sees the support channel". An open
                            channel needs none of it: everybody in the space is
                            already in it, and offering it would read as a way of
                            narrowing something that is not narrowed. */}
                        {channel?.private ? (
                            <div className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                                <div className="min-w-0">
                                    <p className="text-[13px] text-foreground">{t("channelSettings.teamsAndRoles")}</p>
                                    <p className="text-[12px] text-muted-foreground">
                                        {t("channelSettings.letAGroupReachThis")}
                                    </p>
                                </div>
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => setSharing(true)}
                                >
                                    {t("channelSettings.manage")}
                                </Button>
                            </div>
                        ) : null}

                        {error && (
                            <p role="alert" className="text-sm text-danger">
                                {error}
                            </p>
                        )}
                    </div>

                    <DialogFooter className="sm:justify-between">
                        {/* Archiving keeps what was said and deleting does not,
                            so the two are offered together rather than one being
                            found only after the other has been used. */}
                        <span className="flex items-center gap-2">
                            <Button
                                size="sm"
                                variant="secondary"
                                disabled={busy || !channel}
                                onClick={async () => {
                                    if (!channel) return;
                                    await runAction(
                                        () =>
                                            actions.updateChannelAction({
                                                channelId: channel.id,
                                                archived: !channel.archived
                                            }),
                                        setError
                                    );
                                    onOpenChange(false);
                                    refresh();
                                }}
                            >
                                {channel?.archived ? t("channelSettings.reopen") : t("channelSettings.archive")}
                            </Button>
                            <Button
                                size="sm"
                                variant="danger"
                                disabled={busy}
                                onClick={() => setConfirmDelete(true)}
                            >
                                {t("channelSettings.delete")}
                            </Button>
                        </span>
                        <span className="flex items-center gap-2">
                            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                                {t("channelSettings.cancel")}
                            </Button>
                            <Button
                                size="sm"
                                disabled={busy || !stored || !dirty || Boolean(limitError)}
                                onClick={() => void save()}
                            >
                                {busy && <Loader2 className="size-4 animate-spin" />}
                                {t("channelSettings.save")}
                            </Button>
                        </span>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {channel && sharing ? (
                <ShareDialog
                    open
                    onOpenChange={setSharing}
                    subject="chat.channel"
                    subjectId={channel.id}
                    name={channel.name}
                />
            ) : null}

            <ConfirmDeleteDialog
                open={confirmDelete}
                onOpenChange={setConfirmDelete}
                name={channel?.name ?? ""}
                kind="channel"
                description={t("channelSettings.everyMessageInItGoes")}
                confirmLabel={t("channelSettings.deleteChannel")}
                onConfirm={async () => {
                    if (!channel) return;
                    await runAction(() => actions.deleteChannelAction(channel.id), setError);
                    setConfirmDelete(false);
                    onOpenChange(false);
                    refresh();
                    router.push("/chat");
                }}
            />
        </>
    );
}
