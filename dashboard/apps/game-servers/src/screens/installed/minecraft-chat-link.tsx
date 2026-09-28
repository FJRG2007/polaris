"use client";

/**
 * Linked chat: the chat group, or the space's channels, this server talks
 * through (`chat-link.ts`). One place for it, read by everything that needs
 * "this server's chat": the call `{call.*}` shows on the side panel and in
 * announcements, the commands members ask it, the announcements repeated there,
 * and the channel shown in the game.
 */

import { Loader2, MessagesSquare } from "lucide-react";
import { Button, Card, CardBody, Select, Skeleton, Switch } from "@polaris/ui";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import {
    CHAT_COMMANDS,
    chatLinkSchema,
    linkRefusal,
    linkedChannels,
    type ChatLink
} from "../../lib/minecraft/chat-link";
import { readChatLinkAction, saveChatLinkAction, type ChatLinkState } from "./chat-link-actions";

/** A select value for "nothing chosen": an empty value reads as unset. */
const NONE = "none";

/** Why a use that reads or writes the conversation cannot be turned on here. */
const OUTSIDER = "Only somebody who could link this conversation can turn this on.";

type Kind = "none" | "group" | "space";

/** What the form holds, whichever kind is chosen. */
interface Draft {
    readonly kind: Kind;
    readonly groupId: string | null;
    readonly spaceId: string | null;
    readonly callChannelId: string | null;
    readonly textChannelId: string | null;
    readonly commands: boolean;
    readonly announcements: boolean;
    readonly relay: boolean;
}

function draftOf(link: ChatLink | null): Draft {
    const uses = {
        commands: link?.commands ?? true,
        announcements: link?.announcements ?? false,
        relay: link?.relay ?? false
    };
    if (!link) {
        return {
            kind: "none",
            groupId: null,
            spaceId: null,
            callChannelId: null,
            textChannelId: null,
            ...uses
        };
    }
    if (link.kind === "group") {
        return {
            kind: "group",
            groupId: link.groupId,
            spaceId: null,
            callChannelId: null,
            textChannelId: null,
            ...uses
        };
    }
    return {
        kind: "space",
        groupId: null,
        spaceId: link.spaceId,
        callChannelId: link.callChannelId,
        textChannelId: link.textChannelId,
        ...uses
    };
}

/** The link the form describes, or undefined while it is not a whole one. */
function linkOf(draft: Draft): ChatLink | null | undefined {
    if (draft.kind === "none") return null;
    const uses = {
        commands: draft.commands,
        announcements: draft.announcements,
        relay: draft.relay
    };
    const candidate =
        draft.kind === "group"
            ? { kind: "group" as const, groupId: draft.groupId, ...uses }
            : {
                  kind: "space" as const,
                  spaceId: draft.spaceId,
                  callChannelId: draft.callChannelId,
                  textChannelId: draft.textChannelId,
                  ...uses
              };
    const parsed = chatLinkSchema.safeParse(candidate);
    if (!parsed.success) return undefined;
    if (parsed.data.kind === "space" && !parsed.data.callChannelId && !parsed.data.textChannelId) {
        return undefined;
    }
    return parsed.data;
}

/** The card's name and what linking a chat does. */
function ChatLinkHeading() {
    return (
        <div>
            <p className="text-sm font-medium">Linked chat</p>
            <p className="text-xs text-muted-foreground">
                The chat group or space this server talks through. Its call feeds {"{call.*}"} on
                the side panel and in announcements, and it shows the server&apos;s badge in Chat.
            </p>
        </div>
    );
}

export function MinecraftChatLink({ installedAppId }: { installedAppId: string }) {
    const [state, setState] = useState<ChatLinkState | null>(null);
    const [draft, setDraft] = useState<Draft>(draftOf(null));
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const load = useCallback((next: ChatLinkState) => {
        setState(next);
        setDraft(draftOf(next.link));
    }, []);

    useEffect(() => {
        void readChatLinkAction(installedAppId).then((answer) => {
            if (answer.state) load(answer.state);
            else setError(answer.error ?? "The linked chat could not be read");
        });
    }, [installedAppId, load]);

    const link = linkOf(draft);
    // Only a change is worth a save, and the same link saved again is not one.
    const dirty =
        state !== null && link !== undefined && JSON.stringify(link) !== JSON.stringify(state.link);
    const text = linkedChannels(link ?? null).text;

    const change = (patch: Partial<Draft>) => {
        setDraft((current) => ({ ...current, ...patch }));
        setNote(null);
        setError(null);
    };

    const space = useMemo(
        () => state?.linkable.spaces.find((one) => one.id === draft.spaceId) ?? null,
        [state, draft.spaceId]
    );

    function save(): void {
        if (link === undefined) return;
        setError(null);
        startTransition(async () => {
            const result = await saveChatLinkAction({ installedAppId, link });
            if (result.error || !result.state) {
                setError(result.error ?? "That could not be saved");
                return;
            }
            load(result.state);
            setNote(result.state.link ? "Linked." : "Unlinked.");
        });
    }

    // What the card is for is drawn at once; only the choice waits for the link
    // and the chats that could be linked, and a read that failed says so.
    if (!state) {
        return (
            <Card>
                <CardBody className="flex flex-col gap-4">
                    <ChatLinkHeading />
                    {error ? (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    ) : (
                        <div className="flex flex-col gap-1" aria-busy="true">
                            <span className="text-sm font-medium">Link to</span>
                            <Skeleton className="h-9 w-full" />
                        </div>
                    )}
                </CardBody>
            </Card>
        );
    }

    const { groups, spaces } = state.linkable;
    const saved = state.link;
    // What is saved but not offered to this viewer: kept, and said as such.
    const foreignGroup =
        saved?.kind === "group" && !groups.some((one) => one.id === saved.groupId)
            ? saved.groupId
            : null;
    const foreignSpace =
        saved?.kind === "space" && !spaces.some((one) => one.id === saved.spaceId)
            ? saved.spaceId
            : null;
    const rooms = (kind: "text" | "voice", chosen: string | null) => [
        { value: NONE, label: "None" },
        ...(space?.channels ?? [])
            .filter((channel) => channel.kind === kind)
            .map((channel) => ({ value: channel.id, label: `#${channel.name}` })),
        ...(chosen && !space?.channels.some((channel) => channel.id === chosen)
            ? [{ value: chosen, label: "A channel you cannot see" }]
            : [])
    ];
    const outsider = link ? linkRefusal(link, state.linkable) !== null : false;
    const locked = (use: "announcements" | "relay") => outsider && !draft[use] && !saved?.[use];
    const incomplete =
        draft.kind === "group"
            ? !draft.groupId
            : draft.kind === "space" &&
              (!draft.spaceId || (!draft.callChannelId && !draft.textChannelId));

    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                <ChatLinkHeading />

                <label className="flex flex-col gap-1 text-sm">
                    <span className="font-medium">Link to</span>
                    <Select
                        value={draft.kind}
                        onValueChange={(value) => change({ kind: value as Kind })}
                        options={[
                            { value: "none", label: "Nothing" },
                            { value: "group", label: "A chat group" },
                            { value: "space", label: "Channels of a space" }
                        ]}
                        aria-label="What the server is linked to"
                    />
                </label>

                {draft.kind === "group" && (
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">Group *</span>
                        <Select
                            value={draft.groupId ?? NONE}
                            onValueChange={(value) =>
                                change({ groupId: value === NONE ? null : value })
                            }
                            placeholder="Choose a group"
                            options={[
                                ...groups.map((one) => ({ value: one.id, label: one.name })),
                                ...(foreignGroup
                                    ? [{ value: foreignGroup, label: "A group you are not in" }]
                                    : [])
                            ]}
                            aria-label="Chat group"
                        />
                        <span className="text-xs text-muted-foreground">
                            {groups.length === 0
                                ? "You are in no chat group yet. Create one in Chat first."
                                : "Its call is the one {call.*} reads, and commands are answered in it."}
                        </span>
                    </label>
                )}

                {draft.kind === "space" && (
                    <div className="flex flex-col gap-3">
                        <label className="flex flex-col gap-1 text-sm">
                            <span className="font-medium">Space *</span>
                            <Select
                                value={draft.spaceId ?? NONE}
                                onValueChange={(value) =>
                                    change({
                                        spaceId: value === NONE ? null : value,
                                        callChannelId: null,
                                        textChannelId: null
                                    })
                                }
                                placeholder="Choose a space"
                                options={[
                                    ...spaces.map((one) => ({ value: one.id, label: one.name })),
                                    ...(foreignSpace
                                        ? [{ value: foreignSpace, label: "A space you do not run" }]
                                        : [])
                                ]}
                                aria-label="Chat space"
                            />
                            {spaces.length === 0 && (
                                <span className="text-xs text-muted-foreground">
                                    Only a space you own or administer can be linked.
                                </span>
                            )}
                        </label>
                        {draft.spaceId && (
                            <div className="grid gap-3 sm:grid-cols-2">
                                <label className="flex flex-col gap-1 text-sm">
                                    <span className="font-medium">Voice channel for the call</span>
                                    <Select
                                        value={draft.callChannelId ?? NONE}
                                        onValueChange={(value) =>
                                            change({ callChannelId: value === NONE ? null : value })
                                        }
                                        options={rooms("voice", draft.callChannelId)}
                                        aria-label="Voice channel for the call"
                                    />
                                </label>
                                <label className="flex flex-col gap-1 text-sm">
                                    <span className="font-medium">Text channel</span>
                                    <Select
                                        value={draft.textChannelId ?? NONE}
                                        onValueChange={(value) =>
                                            change({ textChannelId: value === NONE ? null : value })
                                        }
                                        options={rooms("text", draft.textChannelId)}
                                        aria-label="Text channel"
                                    />
                                </label>
                                {!draft.callChannelId && !draft.textChannelId && (
                                    <span className="text-xs text-muted-foreground sm:col-span-2">
                                        Choose a voice channel, a text channel, or both.
                                    </span>
                                )}
                            </div>
                        )}
                    </div>
                )}

                {draft.kind !== "none" && (
                    <div className="flex flex-col gap-3 border-t border-border/60 pt-4">
                        <Use
                            label="Answer commands"
                            detail={`Members can type ${CHAT_COMMANDS.map((one) => `/${one.name}`).join(" or ")} there to ask about the server.`}
                            checked={draft.commands}
                            disabled={draft.kind === "space" && !draft.textChannelId}
                            onChange={(commands) => change({ commands })}
                        />
                        <Use
                            label="Repeat announcements"
                            detail={
                                locked("announcements")
                                    ? OUTSIDER
                                    : "An announcement sent to everybody also appears there."
                            }
                            checked={draft.announcements}
                            disabled={
                                locked("announcements") ||
                                (draft.kind === "space" && !draft.textChannelId)
                            }
                            onChange={(announcements) => change({ announcements })}
                        />
                        <Use
                            label="Show its messages in the game"
                            detail={
                                !state.java
                                    ? "Only a Java server can show them."
                                    : locked("relay")
                                      ? OUTSIDER
                                      : "Everybody playing sees them in their chat, whether or not they are in the conversation."
                            }
                            checked={draft.relay}
                            disabled={
                                (!state.java && !draft.relay) ||
                                locked("relay") ||
                                (draft.kind === "space" && !draft.textChannelId)
                            }
                            onChange={(relay) => change({ relay })}
                        />
                    </div>
                )}

                {error && (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                )}
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                        {note ??
                            (text && link !== undefined && !dirty ? (
                                <a
                                    href={`/chat/c/${text}`}
                                    className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-2 hover:underline"
                                >
                                    <MessagesSquare className="size-3.5 shrink-0" />
                                    Open in Chat
                                </a>
                            ) : (
                                ""
                            ))}
                    </span>
                    <Button
                        disabled={pending || !dirty || incomplete}
                        aria-disabled={pending || !dirty || incomplete}
                        onClick={save}
                    >
                        {pending && <Loader2 className="size-4 animate-spin" />}
                        Save
                    </Button>
                </div>
            </CardBody>
        </Card>
    );
}

/** One thing the link is used for, as a switch with a line saying what it does. */
function Use({
    label,
    detail,
    checked,
    disabled,
    onChange
}: {
    label: string;
    detail: string;
    checked: boolean;
    disabled?: boolean;
    onChange: (checked: boolean) => void;
}) {
    return (
        <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
                <p className="text-sm font-medium">{label}</p>
                <p className="text-xs text-muted-foreground">{detail}</p>
            </div>
            <Switch checked={checked} disabled={disabled} onChange={onChange} aria-label={label} />
        </div>
    );
}
