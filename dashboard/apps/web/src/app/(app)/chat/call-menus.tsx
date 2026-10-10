"use client";

/**
 * What right-clicking something in a call offers: a person, or a stream.
 *
 * Both are decisions about this pair of ears - how loud, silenced or not - and
 * are applied where the sound is played, so nobody else is told.
 */

import { useVoiceSettings } from "./voice-settings";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ModerationItems, type SeatModeration } from "./call-moderation-menu";
import { DEFAULT_VOLUME, MAX_VOLUME, useCallVolume } from "./call-volumes";
import { gapFor, gapWords, useLoudness } from "./call-loudness";
import {
    Check,
    Headphones,
    Music2,
    PictureInPicture2,
    Users,
    Volume2,
    VolumeX
} from "lucide-react";
import { setSoundboardMuted, useSoundboardPrefs } from "./soundboard-prefs";
import {
    canPopOut,
    closePopOut,
    popOut,
    streamVolumeKey,
    usePoppedStream,
    useStreamMuted
} from "./call-stream-audio";
import {
    cn,
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuLabel,
    ContextMenuSeparator,
    ContextMenuTrigger
} from "@polaris/ui";

/**
 * What right-clicking somebody offers, wherever they are drawn.
 *
 * Its own component because the two ways a person is drawn are not two kinds of
 * person: turning somebody down, silencing them, and combining audio with them
 * are decisions about the person rather than about the rectangle they happen to
 * be in. Held on the tile alone, they were quietly gone from every call drawn as
 * faces - a stored volume still applied on playback, so the controls vanished
 * while their effects stayed, which is the way for this to go wrong silently.
 *
 * Absent only where there is no volume to set, which is your own picture: it is
 * never played back here.
 */
export function PersonMenu({
    name,
    volumeKey,
    onCombine,
    onAskCombine,
    combineAsked = false,
    combineLocked = false,
    moderation,
    children
}: {
    name: string;
    /** Who this volume is remembered against: their account where they have one,
     *  their seat where they do not. */
    volumeKey: string;
    /** Go quiet and listen through this person's device, and ask them to go
     *  quiet and listen through this one - see `call-combine`. */
    onCombine?: () => void;
    onAskCombine?: () => void;
    combineAsked?: boolean;
    /** Whether the call is too small to combine in, which disables both. */
    combineLocked?: boolean;
    /** Present for somebody who moderates the conversation the call is in:
     *  mute, deafen and disconnect this person for everybody. */
    moderation?: SeatModeration;
    children: React.ReactNode;
}) {
    const t = useTranslations("chat");
    const [volume, setVolume] = useCallVolume(volumeKey);
    const soundsMuted = useSoundboardPrefs().muted.includes(volumeKey);
    // How they arrive against everybody else, measured here while each talks -
    // see `call-loudness`. What turns "they are quiet" into "they are quiet for
    // everybody", which is the difference between this slider and their
    // microphone.
    const gap = gapFor(useLoudness(), volumeKey);
    const arrives = gapWords(gap);
    const db = gap === null ? 0 : Math.round(Math.abs(gap));

    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
            <ContextMenuContent className="w-56">
                <ContextMenuLabel>{name}</ContextMenuLabel>
                <ContextMenuSeparator />
                <ContextMenuItem
                    onSelect={(event) => {
                        // The menu would otherwise close on the press that moved
                        // the slider, which is the one control here that is used
                        // by dragging rather than by choosing.
                        event.preventDefault();
                    }}
                    className="flex-col items-stretch gap-1.5"
                >
                    <span className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{t("callMenus.volume")}</span>
                        <span
                            className={cn(
                                "tabular-nums",
                                volume > DEFAULT_VOLUME && "font-medium text-warning"
                            )}
                        >
                            {Math.round(volume * 100)}%
                        </span>
                    </span>
                    <input
                        type="range"
                        min={0}
                        max={MAX_VOLUME}
                        step={0.05}
                        value={volume}
                        aria-label={t("callMenus.howLoud", { name })}
                        onChange={(event) => setVolume(Number(event.target.value))}
                        className="w-full accent-primary"
                    />
                    {/* Where they were sent, marked on a track that runs past
                        it. Without it there is nothing on screen to find your
                        way back to, and "as loud as they actually are" is the
                        one position on this slider anybody looks for. Pressing
                        it is how you get there. */}
                    <button
                        type="button"
                        onClick={() => setVolume(DEFAULT_VOLUME)}
                        disabled={volume === DEFAULT_VOLUME}
                        className="self-start text-[0.6875rem] text-muted-foreground underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground disabled:no-underline disabled:opacity-60"
                    >
                        {volume === DEFAULT_VOLUME
                            ? t("callMenus.asTheyWereSent")
                            : t("callMenus.backToHowTheyWere")}
                    </button>
                    <span className="text-[0.6875rem] text-muted-foreground">
                        {arrives === "quieter"
                            ? t("callMenus.arrives.quieter", { db })
                            : arrives === "louder"
                              ? t("callMenus.arrives.louder", { db })
                              : arrives === "same"
                                ? t("callMenus.arrives.same")
                                : t("callMenus.arrives.unknown")}
                    </span>
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => setVolume(volume === 0 ? DEFAULT_VOLUME : 0)}>
                    {volume === 0 ? (
                        <Volume2 className="size-3.5" />
                    ) : (
                        <VolumeX className="size-3.5" />
                    )}
                    {volume === 0
                        ? t("callMenus.letThemThrough")
                        : t("callMenus.silenceThemForYou")}
                </ContextMenuItem>
                {/* Their sounds and nothing else: their voice stays as loud as
                    the slider above says. Remembered against their account, for
                    every call after this one, and nobody else is told. */}
                <ContextMenuItem
                    onSelect={() => setSoundboardMuted(volumeKey, !soundsMuted)}
                    aria-checked={soundsMuted}
                    role="menuitemcheckbox"
                >
                    {soundsMuted ? (
                        <Music2 className="size-3.5" />
                    ) : (
                        <VolumeX className="size-3.5" />
                    )}
                    {soundsMuted ? t("soundboard.unmuteUser") : t("soundboard.muteUser")}
                </ContextMenuItem>

                {/* The way to combine with somebody this browser did not hear -
                    across a big room, on a laptop with the volume down, or on a
                    machine where listening for the room is switched off. */}
                {(onCombine || onAskCombine) && <ContextMenuSeparator />}
                {onCombine && (
                    <ContextMenuItem onSelect={onCombine} disabled={combineLocked}>
                        <Headphones className="size-3.5" />
                        {t("callMenus.useTheirAudio")}
                    </ContextMenuItem>
                )}
                {onAskCombine && (
                    <ContextMenuItem
                        onSelect={onAskCombine}
                        disabled={combineAsked || combineLocked}
                    >
                        <Users className="size-3.5" />
                        {combineAsked
                            ? t("callMenus.askedToCombine")
                            : t("callMenus.askThemToCombineAudio")}
                    </ContextMenuItem>
                )}
                {(onCombine || onAskCombine) && combineLocked && (
                    <p className="px-2 pb-1 text-xs text-muted-foreground">
                        {t("callMenus.needsAtLeastThreePeople")}
                    </p>
                )}
                {moderation && <ModerationItems seat={moderation} name={name} />}
            </ContextMenuContent>
        </ContextMenu>
    );
}

/**
 * What right-clicking a shared screen offers, as every voice client has it:
 * its volume, muting it, a window of its own, and how far the voices go down
 * while it plays.
 *
 * The same menu on the stream being watched and on the card offering one, so
 * the sound can be settled before anybody opens it.
 */
export function StreamMenu({
    name,
    person,
    streamKey,
    stream,
    hasSound,
    watching,
    onWatch,
    children
}: {
    name: string;
    /** Whose stream it is: their account where they have one, their seat where
     *  they do not. What its volume and mute are remembered against. */
    person: string;
    /** The room's key for this stream, `screen:<seat>`. */
    streamKey: string;
    stream: MediaStream;
    /** Whether the sharer is sending any sound with it. */
    hasSound: boolean;
    /** Whether it is on this reader's stage. */
    watching: boolean;
    /** Put it on the stage, or take it off. */
    onWatch: () => void;
    children: React.ReactNode;
}) {
    const t = useTranslations("chat");
    const [volume, setVolume] = useCallVolume(streamVolumeKey(person));
    const [muted, setMuted] = useStreamMuted(person);
    const [voice, setVoice] = useVoiceSettings();
    const popped = usePoppedStream() === streamKey;

    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
            <ContextMenuContent className="w-60">
                <ContextMenuLabel className="truncate">{name}</ContextMenuLabel>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={onWatch}>
                    {watching ? t("callMenus.stopWatching") : t("callMenus.watchStream")}
                </ContextMenuItem>
                {canPopOut() && (
                    <ContextMenuItem
                        onSelect={() => {
                            if (popped) {
                                closePopOut();
                                return;
                            }
                            void popOut(streamKey, stream).then((opened) => {
                                // A browser that refused the window still owes
                                // the reader the stream, so it goes on the
                                // stage instead of nothing happening at all.
                                if (!opened && !watching) onWatch();
                            });
                        }}
                    >
                        <PictureInPicture2 className="size-3.5" />
                        {popped ? t("callMenus.closePopOut") : t("callMenus.popOut")}
                    </ContextMenuItem>
                )}
                <ContextMenuSeparator />
                {!hasSound && (
                    <p className="px-2 pb-1 text-xs text-muted-foreground">
                        {t("callMenus.thisStreamHasNoSound")}
                    </p>
                )}
                <ContextMenuItem
                    disabled={!hasSound}
                    onSelect={(event) => {
                        // A switch, not a command: the menu stays so the
                        // slider under it can be reached next.
                        event.preventDefault();
                        setMuted(!muted);
                    }}
                    role="menuitemcheckbox"
                    aria-checked={muted}
                >
                    <Check className={cn("size-3.5", muted ? "opacity-100" : "opacity-0")} />
                    {t("callMenus.muteStream")}
                </ContextMenuItem>
                <ContextMenuItem
                    disabled={!hasSound}
                    onSelect={(event) => event.preventDefault()}
                    className="flex-col items-stretch gap-1.5"
                >
                    <span className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{t("callMenus.streamVolume")}</span>
                        <span
                            className={cn(
                                "tabular-nums",
                                volume > DEFAULT_VOLUME && "font-medium text-warning"
                            )}
                        >
                            {Math.round(volume * 100)}%
                        </span>
                    </span>
                    <input
                        type="range"
                        min={0}
                        max={MAX_VOLUME}
                        step={0.05}
                        value={volume}
                        disabled={!hasSound}
                        aria-label={t("callMenus.howLoud", { name })}
                        onChange={(event) => {
                            const next = Number(event.target.value);
                            setVolume(next);
                            // Dragging it up is somebody wanting to hear it.
                            if (next > 0 && muted) setMuted(false);
                        }}
                        className="w-full accent-primary"
                    />
                </ContextMenuItem>
                <ContextMenuItem
                    disabled={!hasSound}
                    onSelect={(event) => event.preventDefault()}
                    className="flex-col items-stretch gap-1.5"
                >
                    <span className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{t("callMenus.streamAttenuation")}</span>
                        <span className="tabular-nums">{voice.streamAttenuation}%</span>
                    </span>
                    <input
                        type="range"
                        min={0}
                        max={100}
                        step={5}
                        value={voice.streamAttenuation}
                        disabled={!hasSound}
                        aria-label={t("callMenus.howFarOtherVoicesAre")}
                        onChange={(event) =>
                            setVoice({ streamAttenuation: Number(event.target.value) })
                        }
                        className="w-full accent-primary"
                    />
                    <span className="text-[0.6875rem] text-foreground-subtle">
                        {t("callMenus.lowersEverybodyElseWhileA")}
                    </span>
                </ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    );
}
