"use client";

/**
 * What a moderator's right-click on somebody in a call adds: mute, deafen and
 * disconnect, each with its undo - and on a stage, moving them between its
 * speakers and its audience.
 *
 * One component for every place a person in a call is drawn - their face in the
 * call, their row under a voice channel in the rail, and the faces a
 * conversation shows of a call the reader has not joined - so the rule for who
 * sees it and the sentences it says are written once. Whether the reader may
 * moderate is the caller's to pass in; the server asks again either way.
 */

import { useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useToast } from "@polaris/ui";
import { runAction } from "@/lib/run-action";
import { moderateCallAction } from "./meeting-actions";
import { HeadphoneOff, Headphones, Mic, MicOff, PhoneOff, Presentation, Users } from "lucide-react";
import type { CallModeration, SeatRestriction } from "@/lib/chat/voice-moderation";
import type { VoicePresence } from "@/lib/chat/meetings";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuLabel,
    ContextMenuSeparator,
    ContextMenuTrigger
} from "@polaris/ui";

/** What a menu needs to offer moderation over one seat. */
export interface SeatModeration {
    /** The seat, which is what a call knows somebody as. */
    readonly participantId: string;
    /** What a moderator has already done to it, so each item offers its undo. */
    readonly restriction: SeatRestriction;
    /** Whether the call is a stage's, which is what offers inviting somebody
     *  to speak and moving them back to the audience. */
    readonly stage?: boolean;
    /** Called once the server has taken it, so the list can redraw. */
    readonly onDone?: () => void;
}

/** Send one moderation, and say how it went in a note. */
export function useModerate(): {
    moderate: (seat: SeatModeration, action: CallModeration, name: string) => Promise<void>;
    busy: boolean;
} {
    const t = useTranslations("chat");
    const toast = useToast();
    const [busy, setBusy] = useState(false);

    const moderate = async (seat: SeatModeration, action: CallModeration, name: string) => {
        setBusy(true);
        const answer = await runAction(
            () => moderateCallAction({ participantId: seat.participantId, action }),
            (message) => toast.show({ title: message })
        );
        setBusy(false);
        if (!answer) return;
        if (answer.error) {
            toast.show({ title: answer.error });
            return;
        }
        toast.show({ title: t(`callModeration.done.${action}`, { name }), body: answer.warning });
        seat.onDone?.();
    };

    return { moderate, busy };
}

/** The items themselves, for inside a context menu that already exists. */
export function ModerationItems({ seat, name }: { seat: SeatModeration; name: string }) {
    const t = useTranslations("chat");
    const { moderate, busy } = useModerate();
    const { serverMuted, serverDeafened, audience } = seat.restriction;

    return (
        <>
            <ContextMenuSeparator />
            <ContextMenuLabel className="text-xs text-muted-foreground">{t("callModeration.moderation")}</ContextMenuLabel>
            {seat.stage ? (
                <ContextMenuItem
                    disabled={busy}
                    onSelect={() =>
                        void moderate(seat, audience ? "invite-to-speak" : "move-to-audience", name)
                    }
                >
                    {audience ? <Presentation className="size-3.5" /> : <Users className="size-3.5" />}
                    {audience ? t("callModeration.inviteToSpeak") : t("callModeration.moveToAudience")}
                </ContextMenuItem>
            ) : null}
            <ContextMenuItem
                disabled={busy}
                onSelect={() => void moderate(seat, serverMuted ? "unmute" : "mute", name)}
            >
                {serverMuted ? <Mic className="size-3.5" /> : <MicOff className="size-3.5" />}
                {serverMuted ? t("callModeration.serverUnmute") : t("callModeration.serverMute")}
            </ContextMenuItem>
            <ContextMenuItem
                disabled={busy}
                onSelect={() => void moderate(seat, serverDeafened ? "undeafen" : "deafen", name)}
            >
                {serverDeafened ? (
                    <Headphones className="size-3.5" />
                ) : (
                    <HeadphoneOff className="size-3.5" />
                )}
                {serverDeafened ? t("callModeration.serverUndeafen") : t("callModeration.serverDeafen")}
            </ContextMenuItem>
            <ContextMenuItem
                disabled={busy}
                className="text-danger focus:text-danger"
                onSelect={() => void moderate(seat, "disconnect", name)}
            >
                <PhoneOff className="size-3.5" />
                {t("callModeration.disconnect")}
            </ContextMenuItem>
        </>
    );
}

/** Who may moderate the people a roster lists, for a roster drawn outside the
 *  call. Left out where nobody can moderate from it. */
export interface RosterModeration {
    /** Whether the reader moderates the conversation the call belongs to. */
    readonly moderates: boolean;
    /** The reader, who is never offered the menu over themselves. */
    readonly viewerId: string;
    /** Whether the call is a stage's. */
    readonly stage?: boolean;
    /** Called once the server has taken a press, so the roster can redraw. */
    readonly onDone?: () => void;
}

/**
 * One person in a call, wrapped in the moderator's right-click - or left as it
 * is for a reader who does not moderate, and over the reader's own face, which
 * has its own buttons for this.
 */
export function SeatMenu({
    person,
    moderation,
    children
}: {
    person: Pick<VoicePresence, "id" | "userId" | "name" | "serverMuted" | "serverDeafened" | "audience">;
    moderation?: RosterModeration;
    /** The row or face itself; it becomes the menu's trigger. */
    children: React.ReactElement;
}) {
    if (!moderation?.moderates || person.userId === moderation.viewerId) return children;
    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
            <ContextMenuContent className="w-52">
                <ContextMenuLabel className="truncate">{person.name}</ContextMenuLabel>
                <ModerationItems
                    name={person.name}
                    seat={{
                        participantId: person.id,
                        restriction: {
                            serverMuted: person.serverMuted,
                            serverDeafened: person.serverDeafened,
                            audience: person.audience ?? false
                        },
                        stage: moderation.stage,
                        onDone: moderation.onDone
                    }}
                />
            </ContextMenuContent>
        </ContextMenu>
    );
}
