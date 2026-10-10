"use client";

/**
 * The soundboard in a call: the button on the control bar, the picker it opens,
 * and the cue drawn over the face of whoever played something.
 *
 * Laid out the way Discord's is, because that is the one people know: a search
 * field on top, a column of sections down the side - favourites, recently
 * played, Polaris's own sounds, then this space's and every other space the
 * reader brought sounds from - and a grid of sounds, each its emoji and its
 * name. Pressing one plays it to the room. Hovering one offers a star and a
 * preview, which plays it only here.
 *
 * The button is drawn for every seat and disabled, with the reason, for one
 * that may not play - from the same answer the server gives a press
 * (`soundboardRefusal`), with this browser's own microphone and headphones
 * checked first, since those change faster than the server hears about them.
 * The server checks everything again on the press.
 */

import Link from "next/link";
import { createPortal } from "react-dom";
import { Button, cn } from "@polaris/ui";
import { runAction } from "@/lib/run-action";
import type { CallState } from "./call-state";
import * as rules from "@/lib/chat/soundboard";
import { previewSound } from "./soundboard-player";
import type { SoundView } from "@/lib/chat/soundboard-service";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { CallSoundboard } from "@/lib/chat/soundboard-service";
import { shownGlyph, SOUND_GLYPH, type ShownReaction } from "./call-signals";
import { Clock, Loader2, Music2, Search, Sparkles, Star, Volume2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { rememberPlayed, useSoundboardPrefs, useSoundboardVolume } from "./soundboard-prefs";
import { callSoundboardAction, favoriteSoundAction, playSoundAction } from "./soundboard-actions";

/** One sound as the grid draws it, whatever it came from. */
interface Tile {
    readonly ref: string;
    readonly name: string;
    readonly emoji: string;
    /** The space it belongs to, or null for a default. */
    readonly spaceId: string | null;
}

/** The label a default sound is shown under, in the reader's language. */
function useSoundName(): (ref: string, name: string) => string {
    const t = useTranslations("chat");
    return useCallback(
        (ref: string, name: string) => {
            const parsed = rules.parseSoundRef(ref);
            if (parsed?.kind === "default") return t(`soundboard.defaults.${parsed.id}`);
            return name;
        },
        [t]
    );
}

/** What a play or a reaction is drawn as over somebody's face. */
export function Cue({ shown }: { shown: ShownReaction }) {
    const t = useTranslations("chat");
    const nameOf = useSoundName();
    const label = shown.sound
        ? t("soundboard.cue", { name: nameOf(shown.sound.ref, shown.sound.name) })
        : t(`callRoom.reactions.${shown.reaction}`);
    return (
        <span
            aria-label={label}
            title={label}
            className={cn(shown.sound && "motion-safe:animate-bounce")}
        >
            {shownGlyph(shown)}
        </span>
    );
}

/** Each call's last answer, so the picker opens on it while it asks again. */
const boards = new Map<string, CallSoundboard>();

/** The panel's size. Wide enough for four tiles beside the section column. */
const PANEL_WIDTH = 440;
const PANEL_HEIGHT = 420;
const EDGE_GAP = 8;

/** Where the panel goes: above the button where there is room, never off the
 *  side of the window. */
function place(button: DOMRect): {
    left: number;
    bottom?: number;
    top?: number;
    maxHeight: number;
} {
    const width = Math.min(PANEL_WIDTH, window.innerWidth - EDGE_GAP * 2);
    const left = Math.max(
        EDGE_GAP,
        Math.min(button.left + button.width / 2 - width / 2, window.innerWidth - width - EDGE_GAP)
    );
    const above = button.top - EDGE_GAP * 2;
    const below = window.innerHeight - button.bottom - EDGE_GAP * 2;
    if (above >= 240 || above >= below) {
        return {
            left,
            bottom: window.innerHeight - button.top + EDGE_GAP,
            maxHeight: Math.min(above, PANEL_HEIGHT)
        };
    }
    return { left, top: button.bottom + EDGE_GAP, maxHeight: Math.min(below, PANEL_HEIGHT) };
}

/** Why this seat may not play, from this browser's own controls first. */
function localRefusal(call: CallState): rules.SoundboardRefusal | null {
    if (call.moderation.serverMuted || call.moderation.serverDeafened) return "moderated";
    if (call.deafened) return "deafened";
    if (!call.micOn) return "muted";
    return null;
}

const REFUSAL_KEY = {
    guest: "errors.soundboardGuest",
    standalone: "errors.soundboardStandalone",
    spaceOff: "errors.soundboardSpaceOff",
    channelOff: "errors.soundboardChannelOff",
    denied: "errors.soundboardDenied",
    moderated: "errors.soundboardModerated",
    deafened: "errors.soundboardDeafened",
    muted: "errors.soundboardMuted"
} as const satisfies Record<rules.SoundboardRefusal, string>;

export function SoundboardButton({ meetingId, call }: { meetingId: string; call: CallState }) {
    const t = useTranslations("chat");
    const [open, setOpen] = useState(false);
    const [board, setBoard] = useState<CallSoundboard | null>(() => boards.get(meetingId) ?? null);
    const trigger = useRef<HTMLButtonElement>(null);
    const panel = useRef<HTMLDivElement>(null);
    const [at, setAt] = useState<ReturnType<typeof place> | null>(null);

    // Asked when the call opens, so the button already knows whether it is
    // allowed before anybody presses it, and again each time the picker opens.
    const load = useCallback(() => {
        void callSoundboardAction(meetingId).then((answer) => {
            if (!answer.board) return;
            boards.set(meetingId, answer.board);
            setBoard(answer.board);
        });
    }, [meetingId]);
    useEffect(load, [load]);
    useEffect(() => {
        if (open) load();
    }, [open, load]);

    const refusal = localRefusal(call) ?? board?.refusal ?? null;
    const reason = refusal ? t(REFUSAL_KEY[refusal]) : null;
    // A refusal that arrives while the picker is open closes it: the reason is
    // on the button, and a grid of sounds nobody may press is a grid that lies.
    useEffect(() => {
        if (refusal) setOpen(false);
    }, [refusal]);

    const reposition = useCallback(() => {
        const button = trigger.current?.getBoundingClientRect();
        if (button) setAt(place(button));
    }, []);
    useLayoutEffect(() => {
        if (open) reposition();
    }, [open, reposition]);
    useEffect(() => {
        if (!open) return;
        const onDown = (event: MouseEvent) => {
            const target = event.target as Node;
            if (trigger.current?.contains(target) || panel.current?.contains(target)) return;
            setOpen(false);
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            setOpen(false);
            trigger.current?.focus();
        };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        window.addEventListener("resize", reposition);
        return () => {
            document.removeEventListener("mousedown", onDown);
            document.removeEventListener("keydown", onKey);
            window.removeEventListener("resize", reposition);
        };
    }, [open, reposition]);

    const label = reason ?? t("soundboard.button");
    return (
        <>
            {/* Disabled with the reason rather than hidden: a soundboard that
                vanishes when somebody mutes reads as a feature that broke. The
                title is on a wrapper because a disabled button gets no hover. */}
            <span title={label} className="inline-flex">
                <Button
                    ref={trigger}
                    size="icon"
                    variant={open ? "primary" : "secondary"}
                    aria-label={label}
                    aria-haspopup="dialog"
                    aria-expanded={open}
                    disabled={Boolean(refusal)}
                    onClick={() => setOpen((current) => !current)}
                >
                    <Music2 className="size-4" />
                </Button>
            </span>
            {open &&
                at &&
                createPortal(
                    <div
                        ref={panel}
                        role="dialog"
                        aria-label={t("soundboard.button")}
                        style={{
                            left: at.left,
                            top: at.top,
                            bottom: at.bottom,
                            width: Math.min(PANEL_WIDTH, window.innerWidth - EDGE_GAP * 2),
                            height: at.maxHeight
                        }}
                        className="pointer-events-auto fixed z-50 flex flex-col overflow-hidden rounded-lg border border-border-strong bg-elevated shadow-popover"
                    >
                        <SoundboardPanel
                            meetingId={meetingId}
                            board={board}
                            onFavorites={(favorites) => {
                                setBoard((current) => {
                                    if (!current) return current;
                                    const next = { ...current, favorites };
                                    boards.set(meetingId, next);
                                    return next;
                                });
                            }}
                        />
                    </div>,
                    document.body
                )}
        </>
    );
}

/**
 * The inside of the picker.
 *
 * Exported for the README picture, which draws it without a call around it.
 */
export function SoundboardPanel({
    meetingId,
    board,
    onFavorites
}: {
    meetingId: string;
    board: CallSoundboard | null;
    onFavorites: (favorites: readonly string[]) => void;
}) {
    const t = useTranslations("chat");
    const nameOf = useSoundName();
    const prefs = useSoundboardPrefs();
    const [volume, setVolume] = useSoundboardVolume();
    const [query, setQuery] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [coolUntil, setCoolUntil] = useState(0);
    const [now, setNow] = useState(() => Date.now());
    const [busy, setBusy] = useState<string | null>(null);
    const [jump, setJump] = useState<string | null>(null);
    const scroller = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        if (!jump) return;
        scroller.current
            ?.querySelector(`[data-section="${CSS.escape(jump)}"]`)
            ?.scrollIntoView({ block: "start" });
        setJump(null);
    }, [jump]);

    // A tick only while a cooldown runs, so the bar empties and the tiles come
    // back on their own.
    useEffect(() => {
        if (coolUntil <= now) return;
        const timer = window.setTimeout(() => setNow(Date.now()), 100);
        return () => window.clearTimeout(timer);
    }, [coolUntil, now]);
    const cooling = coolUntil > now;
    const cooldownMs = board?.cooldownMs ?? rules.SOUND_COOLDOWN_MS;

    const defaults: Tile[] = useMemo(
        () =>
            rules.DEFAULT_SOUNDS.map((sound) => ({
                ref: rules.defaultRef(sound.id),
                name: "",
                emoji: sound.emoji,
                spaceId: null
            })),
        []
    );
    const groups = useMemo(
        () =>
            (board?.groups ?? []).map((group) => ({
                ...group,
                tiles: group.sounds.map((sound: SoundView) => ({
                    ref: sound.id,
                    name: sound.name,
                    emoji: sound.emoji,
                    spaceId: sound.spaceId
                }))
            })),
        [board]
    );
    const everything = useMemo(() => {
        const all = new Map<string, Tile>();
        for (const tile of defaults) all.set(tile.ref, tile);
        for (const group of groups) for (const tile of group.tiles) all.set(tile.ref, tile);
        return all;
    }, [defaults, groups]);
    const favorites = useMemo(() => new Set(board?.favorites ?? []), [board]);

    const sections = useMemo(() => {
        const pick = (refs: readonly string[]) =>
            refs.flatMap((ref) => {
                const tile = everything.get(ref);
                return tile ? [tile] : [];
            });
        const list: { id: string; title: string; icon: React.ReactNode; tiles: Tile[] }[] = [];
        const starred = pick([...favorites]);
        if (starred.length > 0) {
            list.push({
                id: "favorites",
                title: t("soundboard.favorites"),
                icon: <Star className="size-4" />,
                tiles: starred
            });
        }
        const recent = pick(prefs.recent);
        if (recent.length > 0) {
            list.push({
                id: "recent",
                title: t("soundboard.recent"),
                icon: <Clock className="size-4" />,
                tiles: recent
            });
        }
        list.push({
            id: "defaults",
            title: t("soundboard.defaults.title"),
            icon: <Sparkles className="size-4" />,
            tiles: defaults
        });
        for (const group of groups) {
            list.push({
                id: group.spaceId,
                title: group.spaceName,
                icon: (
                    <span className="text-[0.625rem] font-semibold uppercase">
                        {group.spaceName.slice(0, 2)}
                    </span>
                ),
                tiles: group.tiles
            });
        }
        return list;
    }, [everything, favorites, prefs.recent, defaults, groups, t]);

    const term = query.trim().toLowerCase();
    const shown = term
        ? sections
              .filter((section) => section.id !== "favorites" && section.id !== "recent")
              .map((section) => ({
                  ...section,
                  tiles: section.tiles.filter((tile) =>
                      nameOf(tile.ref, tile.name).toLowerCase().includes(term)
                  )
              }))
              .filter((section) => section.tiles.length > 0)
        : sections;

    const play = async (tile: Tile) => {
        if (cooling || busy) return;
        setBusy(tile.ref);
        setError(null);
        const answer = await runAction(
            () => playSoundAction({ meetingId, sound: tile.ref }),
            setError
        );
        setBusy(null);
        if (!answer) return;
        if (answer.error) {
            setError(answer.error);
            return;
        }
        rememberPlayed(tile.ref);
        setCoolUntil(Date.now() + cooldownMs);
        setNow(Date.now());
    };

    // Optimistic: a star that waits for a round trip reads as a press that did
    // not land. Put back if the server disagrees.
    const star = async (ref: string) => {
        const on = !favorites.has(ref);
        const before = [...favorites];
        onFavorites(on ? [...before, ref] : before.filter((entry) => entry !== ref));
        const answer = await runAction(
            () => favoriteSoundAction({ sound: ref, favorite: on }),
            setError
        );
        if (!answer || answer.error) {
            onFavorites(before);
            if (answer?.error) setError(answer.error);
        }
    };

    return (
        <>
            <div className="flex shrink-0 items-center gap-2 border-b border-border p-2">
                <label className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-background px-2">
                    <Search aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                    <input
                        // The first thing anybody does in a picker of forty sounds.
                        autoFocus
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        placeholder={t("soundboard.search")}
                        aria-label={t("soundboard.search")}
                        className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none"
                    />
                </label>
            </div>

            <div className="flex min-h-0 flex-1">
                <nav
                    aria-label={t("soundboard.sections")}
                    className="flex w-11 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-border py-2 no-scrollbar"
                >
                    {sections.map((section) => (
                        <button
                            key={section.id}
                            type="button"
                            title={section.title}
                            aria-label={section.title}
                            onClick={() => {
                                setQuery("");
                                setJump(section.id);
                            }}
                            className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-card-hover hover:text-foreground"
                        >
                            {section.icon}
                        </button>
                    ))}
                </nav>

                <div ref={scroller} className="min-w-0 flex-1 overflow-y-auto p-2">
                    {board === null && (
                        <p className="flex items-center gap-2 px-1 pb-2 text-xs text-muted-foreground">
                            <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin" />
                            {t("soundboard.loading")}
                        </p>
                    )}
                    {shown.length === 0 && (
                        <p className="px-1 py-6 text-center text-sm text-muted-foreground">
                            {t("soundboard.noMatch")}
                        </p>
                    )}
                    {shown.map((section) => (
                        <section key={section.id} data-section={section.id} className="pb-3">
                            <h3 className="truncate px-1 pb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                {section.title}
                            </h3>
                            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                                {section.tiles.map((tile) => {
                                    const name = nameOf(tile.ref, tile.name);
                                    const starred = favorites.has(tile.ref);
                                    return (
                                        <div
                                            key={`${section.id}:${tile.ref}`}
                                            className="group relative min-w-0"
                                        >
                                            <button
                                                type="button"
                                                disabled={cooling || busy !== null}
                                                onClick={() => void play(tile)}
                                                aria-label={t("soundboard.play", { name })}
                                                title={name}
                                                className="flex h-10 w-full min-w-0 items-center gap-1.5 rounded-md border border-border bg-card px-2 text-left group-focus-within:pr-12 group-hover:pr-12 text-xs transition-colors hover:border-border-strong hover:bg-card-hover disabled:cursor-not-allowed disabled:opacity-60"
                                            >
                                                <span aria-hidden className="shrink-0 text-base">
                                                    {busy === tile.ref ? (
                                                        <Loader2 className="size-4 animate-spin" />
                                                    ) : (
                                                        tile.emoji || SOUND_GLYPH
                                                    )}
                                                </span>
                                                <span className="min-w-0 truncate" title={name}>
                                                    {name}
                                                </span>
                                            </button>
                                            {/* On hover and on focus, so a keyboard reaches them
                                                too. Outside the play button, since a button
                                                inside a button is not one anybody can press. */}
                                            <span className="absolute inset-y-0 right-1 flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        void previewSound(tile.ref, volume)
                                                    }
                                                    aria-label={t("soundboard.preview", { name })}
                                                    title={t("soundboard.preview", { name })}
                                                    className="flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                                                >
                                                    <Volume2 className="size-3.5" />
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => void star(tile.ref)}
                                                    aria-pressed={starred}
                                                    aria-label={
                                                        starred
                                                            ? t("soundboard.unfavorite", { name })
                                                            : t("soundboard.favorite", { name })
                                                    }
                                                    title={
                                                        starred
                                                            ? t("soundboard.unfavorite", { name })
                                                            : t("soundboard.favorite", { name })
                                                    }
                                                    className={cn(
                                                        "flex size-5 items-center justify-center rounded hover:text-foreground",
                                                        starred
                                                            ? "text-warning"
                                                            : "text-muted-foreground"
                                                    )}
                                                >
                                                    <Star
                                                        className={cn(
                                                            "size-3.5",
                                                            starred && "fill-current"
                                                        )}
                                                    />
                                                </button>
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        </section>
                    ))}
                </div>
            </div>

            {cooling && (
                <div
                    role="status"
                    className="h-0.5 shrink-0 bg-primary transition-[width] duration-100 ease-linear"
                    style={{ width: `${Math.max(0, ((coolUntil - now) / cooldownMs) * 100)}%` }}
                    aria-label={t("soundboard.cooling")}
                />
            )}
            {error && (
                <p
                    role="alert"
                    className="shrink-0 border-t border-border px-3 py-1.5 text-xs text-danger"
                >
                    {error}
                </p>
            )}
            <div className="flex shrink-0 items-center gap-3 border-t border-border px-3 py-2">
                <Volume2 aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={Math.round(volume * 100)}
                    onChange={(event) => setVolume(Number(event.target.value) / 100)}
                    aria-label={t("soundboard.volume")}
                    title={t("soundboard.volume")}
                    className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                />
                <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                    {Math.round(volume * 100)}%
                </span>
                {board?.manageSpaceId && (
                    <Link
                        href={`/chat/s/${board.manageSpaceId}/soundboard`}
                        className="shrink-0 text-xs text-primary hover:underline"
                    >
                        {t("soundboard.manage")}
                    </Link>
                )}
            </div>
        </>
    );
}
