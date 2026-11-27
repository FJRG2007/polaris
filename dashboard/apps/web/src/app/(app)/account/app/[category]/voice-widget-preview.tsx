"use client";

/**
 * The voice widget's own pieces of "This app": a live preview drawn from the
 * values on screen (so a change shows here the moment it is made, before the
 * app answers), the "Max users displayed" slider with Discord's marks, and the
 * button that puts the widget back as it first came.
 *
 * The preview follows the widget's rules in `clients/desktop/src/shared/voice-widget.ts`:
 * who is listed, when a name shows, how many rows before "and N more", the
 * opacity it has while locked, and the quick actions while they are clickable.
 * Faces are the same `Avatar` a call draws - initials underneath, the picture
 * over them - with the viewer first, as their own face in a real call.
 */

import { useState } from "react";
import * as core from "@polaris/core/app-settings";
import type { PolarisDesktop } from "@/lib/desktop-bridge";
import { Avatar } from "@/components/avatar";
import { useSessionViewer } from "@/components/session-scope";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { HeadphoneOff, Headphones, Mic, MicOff, PhoneOff } from "lucide-react";
import {
    Button,
    Card,
    CardBody,
    ControlSlider,
    Switch,
    cn,
    settingType,
    useToast
} from "@polaris/ui";

/**
 * The sample call drawn in the preview: fixture people, one talking, one muted,
 * one deafened. Most have a bundled illustration for a picture, as most people
 * in a real call do; two keep their initials so the face with none shows too.
 */
export const SAMPLE = [
    { id: "a", speaking: true, muted: false, deafened: false, picture: "/voice-widget/sample-a.svg" },
    { id: "b", speaking: false, muted: true, deafened: false, picture: null },
    { id: "c", speaking: false, muted: false, deafened: false, picture: "/voice-widget/sample-c.svg" },
    { id: "d", speaking: false, muted: true, deafened: true, picture: "/voice-widget/sample-d.svg" },
    { id: "e", speaking: true, muted: false, deafened: false, picture: "/voice-widget/sample-e.svg" },
    { id: "f", speaking: false, muted: false, deafened: false, picture: null }
] as const;

/** The widget's face sizes (`ROW_METRICS` in the desktop app's voice widget). */
const FACE = { large: 32, small: 22 } as const;

interface PreviewPerson {
    readonly key: string;
    /** The account behind the face, null for a sample (no picture is asked for). */
    readonly id: string | null;
    readonly name: string;
    readonly picture: string | null;
    readonly speaking: boolean;
    readonly muted: boolean;
    readonly deafened: boolean;
}

/** How many rows are drawn: the chosen number, or everybody when Off. */
export function previewRows(people: number, maxUsers: number): { shown: number; more: number } {
    const shown = maxUsers === 0 ? people : Math.min(people, maxUsers);
    return { shown, more: people - shown };
}

export function VoiceWidgetPreview({ snapshot }: { snapshot: core.AppSettingsSnapshot }) {
    const t = useTranslations("appSettings");
    const viewer = useSessionViewer();
    const large = snapshot.voiceWidgetAvatars === "large";
    const people: PreviewPerson[] = [
        // The viewer's own face, from the session the page already has: the
        // picture is the same address every other face of theirs loads.
        ...(viewer
            ? [{ key: "viewer", id: viewer.id, name: viewer.name, picture: null, speaking: false, muted: false, deafened: false }]
            : []),
        ...SAMPLE.map((person) => ({ ...person, key: person.id, id: null, name: t(`overlay.people.${person.id}`) }))
    ];
    const listed = people.filter((person) => snapshot.voiceWidgetPeople === "always" || person.speaking);
    const { shown, more } = previewRows(listed.length, snapshot.voiceWidgetMaxUsers);
    const actions = snapshot.overlayQuickActions && snapshot.overlayClickable;
    const right = snapshot.voiceWidgetCorner.endsWith("right");
    const bottom = snapshot.voiceWidgetCorner.startsWith("bottom");
    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                    <span className={settingType.body}>{t("overlay.preview")}</span>
                    <span className={settingType.hint}>{t("overlay.previewHint")}</span>
                </div>
                <div
                    role="img"
                    aria-label={t("overlay.preview")}
                    className={cn(
                        "flex min-h-56 rounded-lg bg-muted/50 p-4",
                        right ? "justify-end" : "justify-start",
                        bottom ? "items-end" : "items-start"
                    )}
                >
                    <div
                        className="flex min-w-0 max-w-full flex-col gap-1 rounded-lg border border-dashed border-border p-2 transition-opacity"
                        style={{ opacity: Number(snapshot.voiceWidgetOpacity) / 100 }}
                    >
                        {listed.slice(0, shown).map((person) => {
                            const name = person.name;
                            const named =
                                snapshot.voiceWidgetNames === "always" ||
                                (snapshot.voiceWidgetNames === "speaking" && person.speaking);
                            return (
                                <div key={person.key} className="flex min-w-0 items-center gap-2">
                                    <Avatar
                                        person={{ id: person.id, name, image: person.picture }}
                                        size={large ? FACE.large : FACE.small}
                                        // As the widget does: the mute mark on the face when no plate shows.
                                        callBadge={named ? null : person.deafened ? "deafened" : person.muted ? "muted" : null}
                                        className={cn(
                                            "transition-shadow duration-fast",
                                            person.speaking && "ring-2 ring-success"
                                        )}
                                    />
                                    {named && (
                                        <span className={cn(settingType.small, "flex min-w-0 items-center gap-1 rounded-full bg-background/80 px-2 py-0.5")}>
                                            <span className="truncate" title={name}>{name}</span>
                                            {person.muted && <MicOff className="size-3 shrink-0 text-danger" aria-hidden />}
                                            {person.deafened && (
                                                <HeadphoneOff className="size-3 shrink-0 text-danger" aria-hidden />
                                            )}
                                        </span>
                                    )}
                                </div>
                            );
                        })}
                        {more > 0 && (
                            <span className={cn(settingType.hint, "px-1")}>
                                {t("overlay.more", { count: more })}
                            </span>
                        )}
                        {listed.length === 0 && (
                            <span className={cn(settingType.hint, "px-1")}>{t("overlay.nobody")}</span>
                        )}
                        {actions && (
                            <div className="mt-1 flex items-center gap-1" aria-hidden>
                                {[Mic, Headphones, PhoneOff].map((Icon, index) => (
                                    <span
                                        key={index}
                                        className="flex size-7 shrink-0 items-center justify-center rounded-md bg-background/80"
                                    >
                                        <Icon className="size-3.5 shrink-0" />
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </CardBody>
        </Card>
    );
}

/** "Max users displayed": a slider from Off to 25 with Discord's marks under it. */
export function MaxUsersRow({
    entry,
    value,
    onChange
}: {
    entry: Extract<core.AppSettingEntry, { kind: "range" }>;
    value: number;
    onChange: (value: number) => void;
}) {
    const t = useTranslations("appSettings");
    const label = t("items.voiceWidgetMaxUsers.label");
    const text = (count: number) => (count === 0 ? t("items.voiceWidgetMaxUsers.off") : String(count));
    return (
        <div className="flex flex-col gap-2">
            <div className="flex min-w-0 items-baseline justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                    <span className={settingType.body}>{label}</span>
                    <span className={settingType.hint}>{t("items.voiceWidgetMaxUsers.hint")}</span>
                </div>
                <span className={cn(settingType.body, "shrink-0 tabular-nums text-muted-foreground")}>{text(value)}</span>
            </div>
            <ControlSlider
                value={value}
                min={entry.min}
                max={entry.max}
                step={entry.step}
                label={label}
                valueText={text}
                onCommit={onChange}
            />
            <div className={cn(settingType.hint, "relative h-4")} aria-hidden>
                {entry.marks.map((mark) => {
                    const at = ((mark - entry.min) / (entry.max - entry.min)) * 100;
                    return (
                        <span
                            key={mark}
                            className="absolute top-0 tabular-nums"
                            style={{ left: `${at}%`, transform: `translateX(-${at}%)` }}
                        >
                            {text(mark)}
                        </span>
                    );
                })}
            </div>
        </div>
    );
}

/** Puts the widget back as it first came; shown only by an app that can. */
/**
 * Discord's per-game overlay switch: the game running now and every game the
 * overlay was turned off for, each with its own switch. A switch moves at once
 * and goes back when the app refuses it. Absent with an app that predates it.
 */
export function OverlayGames({
    snapshot,
    settings,
    onSnapshot
}: {
    snapshot: core.AppSettingsSnapshot;
    settings: NonNullable<PolarisDesktop["appSettings"]>;
    onSnapshot: (next: core.AppSettingsSnapshot) => void;
}) {
    const t = useTranslations("appSettings");
    const toast = useToast();
    const setGame = settings.setOverlayGame;
    if (!setGame || !snapshot.features.includes("overlayGames")) return null;
    const turn = (key: string, on: boolean) => {
        const before = snapshot;
        onSnapshot({ ...before, overlayGames: before.overlayGames.map((game) => (game.key === key ? { ...game, on } : game)) });
        void setGame(key, on)
            .catch(() => null)
            .then((answer) => {
                const next = core.readAppSettings(answer);
                if (next) return onSnapshot(next);
                onSnapshot(before);
                toast.show({ title: t("saveFailed") });
            });
    };
    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                <div className="flex min-w-0 flex-col gap-0.5">
                    <span className={settingType.body}>{t("overlay.games")}</span>
                    <span className={settingType.hint}>{t("overlay.gamesHint")}</span>
                </div>
                {snapshot.overlayGames.length === 0 ? (
                    <p className={settingType.hint}>{t("overlay.gamesEmpty")}</p>
                ) : (
                    snapshot.overlayGames.map((game) => (
                        <div key={game.key} className="flex items-center justify-between gap-3">
                            <div className="flex min-w-0 flex-1 items-center gap-2">
                                <span className={cn(settingType.body, "truncate")} title={game.name || game.key}>
                                    {game.name || game.key}
                                </span>
                                {game.running && (
                                    <span className={cn(settingType.small, "shrink-0 rounded bg-success-soft px-1.5 py-0.5 text-success")}>
                                        {t("overlay.running")}
                                    </span>
                                )}
                            </div>
                            <Switch checked={game.on} aria-label={game.name || game.key} onChange={(on) => turn(game.key, on)} />
                        </div>
                    ))
                )}
            </CardBody>
        </Card>
    );
}

export function ResetOverlay({
    settings,
    onSnapshot
}: {
    settings: NonNullable<PolarisDesktop["appSettings"]>;
    onSnapshot: (next: core.AppSettingsSnapshot) => void;
}) {
    const t = useTranslations("appSettings");
    const toast = useToast();
    const [pending, setPending] = useState(false);
    const reset = settings.resetOverlay;
    if (!reset) return null;
    return (
        <Card>
            <CardBody className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className={settingType.body}>{t("overlay.reset")}</span>
                    <span className={settingType.hint}>{t("overlay.resetHint")}</span>
                </div>
                <Button
                    size="sm"
                    variant="secondary"
                    disabled={pending}
                    onClick={() => {
                        setPending(true);
                        void reset()
                            .catch(() => null)
                            .then((answer) => {
                                const next = core.readAppSettings(answer);
                                if (!next) return toast.show({ title: t("saveFailed") });
                                onSnapshot(next);
                                toast.show({ title: t("overlay.resetDone") });
                            })
                            .finally(() => setPending(false));
                    }}
                >
                    {t("overlay.reset")}
                </Button>
            </CardBody>
        </Card>
    );
}
