"use client";

/**
 * Adding a channel to a space.
 *
 * The name is normalized as it is typed, with the stored form shown underneath,
 * because "Release Planning" becoming `release-planning` is a surprise the first
 * time and an annoyance every time after. Showing it removes both: what you see
 * is what the channel will be called.
 *
 * The type is picked from cards the way Discord's Create Channel does it: an
 * icon, a name and one line on what the room is for, with the same icon in
 * front of the name field so the choice stays visible while typing.
 */

import * as core from "@polaris/core";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useChat } from "./chat-context";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { createChannelAction } from "./actions";
import type { ChatSpaceView } from "@/lib/chat/chat-service";
import { Hash, Images, Loader2, Lock, Megaphone, MessagesSquare, Volume2, type LucideIcon } from "lucide-react";
import {
    Button,
    cn,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Switch,
    useToast
} from "@polaris/ui";
import { ChatPeoplePicker } from "./chat-people-picker";
import type { PickedPerson } from "@/components/people-picker";

/** Each type's icon, shared by its card and the name field. */
const TYPE_ICONS: Record<core.ChatChannelCreateType, LucideIcon> = {
    text: Hash,
    voice: Volume2,
    announcement: Megaphone,
    forum: MessagesSquare,
    media: Images
};

export function NewChannelDialog({
    space,
    categoryId = null,
    onOpenChange
}: {
    /** The space it goes in. Null closes the dialog - one prop rather than a
     *  boolean beside it, so the two cannot disagree. */
    space: ChatSpaceView | null;
    /** The heading it goes under, when the dialog was opened from one. */
    categoryId?: string | null;
    onOpenChange: (open: boolean) => void;
}) {
    const t = useTranslations("chat");
    const router = useRouter();
    const { refresh } = useChat();
    const [name, setName] = useState("");
    const [topic, setTopic] = useState("");
    const [type, setType] = useState<core.ChatChannelCreateType>("text");
    const [privateChannel, setPrivateChannel] = useState(false);
    const [members, setMembers] = useState<readonly PickedPerson[]>([]);
    const toast = useToast();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    const stored = useMemo(() => core.normalizeChannelName(name), [name]);
    // The sidebar draws a private text room with a lock, so the field does too.
    const NameIcon = privateChannel && type === "text" ? Lock : TYPE_ICONS[type];

    const create = async () => {
        if (!space) return;
        setBusy(true);
        setError("");
        const result = await runAction(
            () =>
                createChannelAction({
                    spaceId: space.id,
                    name,
                    topic,
                    kind: type === "announcement" ? "text" : type,
                    announcement: type === "announcement",
                    categoryId,
                    private: privateChannel,
                    memberIds: privateChannel ? members.map((person) => person.id) : []
                }),
            setError
        );
        setBusy(false);
        if (result?.error || !result?.id) return;
        setName("");
        setTopic("");
        setType("text");
        setPrivateChannel(false);
        setMembers([]);
        onOpenChange(false);
        refresh();
        if (result.membersError) toast.show({ title: t("newChannel.membersNotAdded"), body: result.membersError });
        router.push(`/chat/c/${result.id}`);
    };

    return (
        <Dialog open={space !== null} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("newChannel.newChannel")}</DialogTitle>
                    <DialogDescription>{t("newChannel.inSpace", { name: space?.name ?? t("newChannel.thisSpace") })}</DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-3">
                    <div className="flex flex-col gap-1.5">
                        <p className="text-xs font-medium text-muted-foreground">{t("newChannel.channelType")}</p>
                        <div
                            role="radiogroup"
                            aria-label={t("newChannel.whatKindOfChannel")}
                            className="flex flex-col gap-1.5"
                        >
                            {core.CHAT_CHANNEL_CREATE_TYPES.map((option) => {
                                const Icon = TYPE_ICONS[option];
                                const chosen = type === option;
                                return (
                                    <button
                                        key={option}
                                        type="button"
                                        role="radio"
                                        aria-checked={chosen}
                                        onClick={() => setType(option)}
                                        className={cn(
                                            "flex min-w-0 items-center gap-3 rounded-md border px-3 py-2 text-start transition-colors",
                                            chosen ? "border-primary bg-primary/10" : "border-border hover:bg-card-hover"
                                        )}
                                    >
                                        <Icon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
                                        <span className="flex min-w-0 flex-1 flex-col">
                                            <span className="truncate text-sm font-medium">
                                                {t(`newChannel.types.${option}.name`)}
                                            </span>
                                            <span className="text-xs text-muted-foreground">
                                                {t(`newChannel.types.${option}.hint`)}
                                            </span>
                                        </span>
                                        <span
                                            aria-hidden
                                            className={cn(
                                                "size-3.5 shrink-0 rounded-full border",
                                                chosen
                                                    ? "border-primary bg-primary shadow-[inset_0_0_0_2px_var(--color-background,white)]"
                                                    : "border-border-strong"
                                            )}
                                        />
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    <div className="flex flex-col gap-1">
                        <div className="relative">
                            <NameIcon
                                aria-hidden
                                className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                            />
                            <Input
                                value={name}
                                autoFocus
                                className="ps-8"
                                aria-label={t("newChannel.channelName")}
                                placeholder="release-planning"
                                maxLength={80}
                                onChange={(event) => setName(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter" && stored && !busy) void create();
                                }}
                            />
                        </div>
                        {stored && stored !== name && (
                            <p className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                                <NameIcon className="size-3 shrink-0" />
                                <span className="truncate" title={stored}>{stored}</span>
                            </p>
                        )}
                    </div>

                    <Input
                        value={topic}
                        aria-label={t("newChannel.whatItIsFor")}
                        placeholder={t("newChannel.whatItIsForOptional")}
                        maxLength={200}
                        onChange={(event) => setTopic(event.target.value)}
                    />

                    {type === "voice" && (
                        <p className="text-xs text-muted-foreground">
                            {t("newChannel.aVoiceChannelHasA")}
                        </p>
                    )}

                    <label className="flex items-start gap-3 rounded-md border border-border px-3 py-2">
                        <Switch checked={privateChannel} onChange={setPrivateChannel} />
                        <span className="flex min-w-0 flex-col gap-0.5">
                            <span className="text-sm font-medium">{t("newChannel.private")}</span>
                            <span className="text-xs text-muted-foreground">
                                {t("newChannel.onlyThePeopleAddedTo")}
                            </span>
                        </span>
                    </label>

                    {privateChannel && (
                        <ChatPeoplePicker
                            forGroup={false}
                            picked={members}
                            onChange={setMembers}
                            label={t("newChannel.members")}
                        />
                    )}

                    {error && (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                        {t("newChannel.cancel")}
                    </Button>
                    <Button size="sm" disabled={busy || !stored} onClick={() => void create()}>
                        {busy && <Loader2 className="size-4 animate-spin" />}
                        {type === "voice" ? t("newChannel.createVoice") : t("newChannel.createText")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
