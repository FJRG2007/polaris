"use client";

/**
 * The call, drawn in the conversation it is in, for somebody not in it yet.
 *
 * A dark stage over the messages: the faces of whoever is in the call, the
 * caller's ringing while it rings, a mute mark on anybody muted, and the ways
 * in centred under them - with the camera, by voice, and, while it rings,
 * decline. Joining turns it into the call itself, in the same place.
 */

import { useEffect } from "react";
import { Button, cn } from "@polaris/ui";
import { callSummary } from "./call-preview";
import { LiveBadge, callBadgeOf } from "./call-roster";
import { Avatar } from "@/components/avatar";
import { showStage } from "@/lib/chat/call-stage";
import type { VoicePresence } from "@/lib/chat/meetings";
import { ChevronUp, PhoneCall, Video, X } from "lucide-react";
import { PersonName, PersonRow } from "@/components/person-name";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { SeatMenu, type RosterModeration } from "./call-moderation-menu";

const AVATAR_SIZE = 80;

/** The face of the person ringing, before the roster has been read. */
export interface StageCaller {
    readonly id: string;
    readonly name: string;
}

export function CallStage({
    meetingId,
    people,
    count,
    caller,
    canJoin,
    busy = false,
    onJoin,
    onDecline,
    onHide,
    moderation
}: {
    meetingId: string;
    people: readonly VoicePresence[];
    count: number;
    /** Set while the call rings at this reader. */
    caller: StageCaller | null;
    canJoin: boolean;
    busy?: boolean;
    onJoin: (withVideo: boolean) => void;
    onDecline: () => void;
    onHide: () => void;
    moderation?: RosterModeration;
}) {
    const t = useTranslations("chat");
    const ringing = caller !== null;

    // On screen, so the corner card for the same call steps aside.
    useEffect(() => showStage(meetingId), [meetingId]);

    // The caller is seated when it starts ringing, but the roster may not have
    // been read yet: their face is drawn from the ring until it has.
    const callerSeated = caller !== null && people.some((person) => person.userId === caller.id);
    const faces: readonly { key: string; person: VoicePresence | null; id: string; name: string }[] = [
        ...(caller && !callerSeated && caller.id
            ? [{ key: `ring:${caller.id}`, person: null, id: caller.id, name: caller.name }]
            : []),
        ...people.map((person) => ({
            key: person.id,
            person,
            id: person.userId ?? person.id,
            name: person.name
        }))
    ];

    return (
        <section
            aria-label={ringing ? t("callStage.incomingCall") : t("callPreview.callInProgress")}
            className="relative flex max-h-[60vh] min-h-56 shrink-0 flex-col gap-4 border-b border-border bg-black px-4 pb-4 pt-3 text-white"
        >
            <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-white/80">
                    {caller?.name
                        ? t("callStage.calling", { name: caller.name })
                        : callSummary(count)}
                </span>
                <button
                    type="button"
                    onClick={onHide}
                    aria-label={t("callPreview.hideTheCall")}
                    title={t("callPreview.hideTheCallItKeeps")}
                    className="rounded p-1.5 text-white/60 transition-colors hover:bg-white/10 hover:text-white"
                >
                    <ChevronUp className="size-4" />
                </button>
            </div>

            <ul className="flex min-h-0 flex-1 flex-wrap content-center items-start justify-center gap-x-6 gap-y-4 overflow-y-auto overscroll-contain">
                {faces.map((face) => {
                    const pulsing = caller !== null && face.id === caller.id;
                    const avatar = (
                        <span className="relative inline-flex rounded-full">
                            {pulsing && (
                                <>
                                    {/* Still when motion is reduced: the ring
                                        stays, it only stops moving. */}
                                    <span
                                        aria-hidden
                                        data-testid="ring-pulse"
                                        className="absolute -inset-1.5 rounded-full ring-2 ring-white/80"
                                    />
                                    <span
                                        aria-hidden
                                        className="absolute -inset-1.5 rounded-full ring-2 ring-white/50 motion-safe:animate-ping"
                                    />
                                </>
                            )}
                            <Avatar
                                size={AVATAR_SIZE}
                                person={{ id: face.id, name: face.name }}
                                callBadge={face.person ? callBadgeOf(face.person) : null}
                            />
                        </span>
                    );
                    const label = (
                        <span className="flex w-full items-center justify-center gap-1 text-xs text-white/80">
                            <span className="min-w-0 truncate">
                                <PersonName id={face.id} name={face.name} />
                            </span>
                            {face.person?.streaming && <LiveBadge />}
                        </span>
                    );
                    return face.person ? (
                        <SeatMenu key={face.key} person={face.person} moderation={moderation}>
                            <PersonRow
                                as="li"
                                personId={face.person.userId}
                                plate="never"
                                className="flex w-24 shrink-0 flex-col items-center gap-2"
                                title={face.name}
                            >
                                {avatar}
                                {label}
                            </PersonRow>
                        </SeatMenu>
                    ) : (
                        <li
                            key={face.key}
                            title={face.name}
                            className="flex w-24 shrink-0 flex-col items-center gap-2"
                        >
                            {avatar}
                            {label}
                        </li>
                    );
                })}
            </ul>

            {(canJoin || ringing) && (
                <div className="flex shrink-0 flex-wrap items-center justify-center gap-3">
                    {canJoin && (
                        <>
                            <StageButton
                                label={t("callStage.joinWithVideo")}
                                tone="join"
                                disabled={busy}
                                onClick={() => onJoin(true)}
                            >
                                <Video className="size-5" />
                            </StageButton>
                            <StageButton
                                label={t("callPreview.join")}
                                tone="join"
                                disabled={busy}
                                onClick={() => onJoin(false)}
                            >
                                <PhoneCall className="size-5" />
                            </StageButton>
                        </>
                    )}
                    {ringing && (
                        <StageButton
                            label={t("callStage.decline")}
                            tone="decline"
                            disabled={busy}
                            onClick={onDecline}
                        >
                            <X className="size-5" />
                        </StageButton>
                    )}
                </div>
            )}
        </section>
    );
}

function StageButton({
    label,
    tone,
    disabled,
    onClick,
    children
}: {
    label: string;
    tone: "join" | "decline";
    disabled: boolean;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (
        <Button
            variant={tone === "decline" ? "hangUp" : "primary"}
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={onClick}
            className={cn(
                "h-12 w-16 rounded-lg px-0",
                tone === "join" &&
                    "border-0 bg-success text-white hover:bg-success/90 active:bg-success/80"
            )}
        >
            {children}
        </Button>
    );
}
