"use client";

/**
 * The voice widget's own pieces of "This app": a live preview drawn from the
 * values on screen (so a change shows here the moment it is made, before the
 * app answers), the "Max users displayed" slider with Discord's marks, and the
 * button that puts the widget back as it first came.
 *
 * The preview follows the widget's rules in `desktop/src/shared/voice-widget.ts`:
 * who is listed, when a name shows, how many rows before "and N more", the
 * opacity it has while locked, and the quick actions while they are clickable.
 */

import { useState } from "react";
import * as core from "@polaris/core/app-settings";
import type { PolarisDesktop } from "@/lib/desktop-bridge";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { HeadphoneOff, Headphones, Mic, MicOff, PhoneOff } from "lucide-react";
import { Button, Card, CardBody, ControlSlider, Switch, cn, useToast } from "@polaris/ui";

/** The sample call drawn in the preview: fixture people, one talking, one muted, one deafened. */
const SAMPLE = [
    { id: "a", speaking: true, muted: false, deafened: false, hue: 210 },
    { id: "b", speaking: false, muted: true, deafened: false, hue: 262 },
    { id: "c", speaking: false, muted: false, deafened: false, hue: 330 },
    { id: "d", speaking: false, muted: true, deafened: true, hue: 20 },
    { id: "e", speaking: true, muted: false, deafened: false, hue: 150 },
    { id: "f", speaking: false, muted: false, deafened: false, hue: 45 }
] as const;

/** Up to two letters for a face, as the widget draws one with no picture. */
function initials(name: string): string {
    const words = name.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return "?";
    const letters = words.length === 1 ? [...words[0]!].slice(0, 2) : [[...words[0]!][0], [...words[words.length - 1]!][0]];
    return letters.join("").toUpperCase();
}

/** How many rows are drawn: the chosen number, or everybody when Off. */
export function previewRows(people: number, maxUsers: number): { shown: number; more: number } {
    const shown = maxUsers === 0 ? people : Math.min(people, maxUsers);
    return { shown, more: people - shown };
}

export function VoiceWidgetPreview({ snapshot }: { snapshot: core.AppSettingsSnapshot }) {
    const t = useTranslations("appSettings");
    const large = snapshot.voiceWidgetAvatars === "large";
    const listed = SAMPLE.filter((person) => snapshot.voiceWidgetPeople === "always" || person.speaking);
    const { shown, more } = previewRows(listed.length, snapshot.voiceWidgetMaxUsers);
    const actions = snapshot.overlayQuickActions && snapshot.overlayClickable;
    const right = snapshot.voiceWidgetCorner.endsWith("right");
    const bottom = snapshot.voiceWidgetCorner.startsWith("bottom");
    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm">{t("overlay.preview")}</span>
                    <span className="text-xs text-muted-foreground">{t("overlay.previewHint")}</span>
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
                            const name = t(`overlay.people.${person.id}`);
                            const named =
                                snapshot.voiceWidgetNames === "always" ||
                                (snapshot.voiceWidgetNames === "speaking" && person.speaking);
                            return (
                                <div key={person.id} className="flex min-w-0 items-center gap-2">
                                    <span
                                        title={named ? undefined : name}
                                        className={cn(
                                            "flex shrink-0 items-center justify-center rounded-full font-medium text-white",
                                            large ? "size-8 text-xs" : "size-5 text-[0.625rem]",
                                            person.speaking && "ring-2 ring-success ring-offset-1 ring-offset-background"
                                        )}
                                        style={{ background: `hsl(${person.hue} 55% 45%)` }}
                                    >
                                        {initials(name)}
                                    </span>
                                    {named && (
                                        <span className="flex min-w-0 items-center gap-1 rounded-full bg-background/80 px-2 py-0.5 text-xs">
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
                            <span className="px-1 text-xs text-muted-foreground">
                                {t("overlay.more", { count: more })}
                            </span>
                        )}
                        {listed.length === 0 && (
                            <span className="px-1 text-xs text-muted-foreground">{t("overlay.nobody")}</span>
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
                    <span className="text-sm">{label}</span>
                    <span className="text-xs text-muted-foreground">{t("items.voiceWidgetMaxUsers.hint")}</span>
                </div>
                <span className="shrink-0 text-sm tabular-nums text-muted-foreground">{text(value)}</span>
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
            <div className="relative h-4 text-xs text-muted-foreground" aria-hidden>
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
                    <span className="text-sm">{t("overlay.games")}</span>
                    <span className="text-xs text-muted-foreground">{t("overlay.gamesHint")}</span>
                </div>
                {snapshot.overlayGames.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t("overlay.gamesEmpty")}</p>
                ) : (
                    snapshot.overlayGames.map((game) => (
                        <div key={game.key} className="flex items-center justify-between gap-3">
                            <div className="flex min-w-0 flex-1 items-center gap-2">
                                <span className="truncate text-sm" title={game.name || game.key}>
                                    {game.name || game.key}
                                </span>
                                {game.running && (
                                    <span className="shrink-0 rounded bg-success/15 px-1.5 py-0.5 text-xs text-success">
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
                    <span className="text-sm">{t("overlay.reset")}</span>
                    <span className="text-xs text-muted-foreground">{t("overlay.resetHint")}</span>
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
