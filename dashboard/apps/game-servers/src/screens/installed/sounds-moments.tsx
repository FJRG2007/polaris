"use client";

/**
 * What the server does with its sounds: the pack's own options, the moments a
 * sound is put on, and the players who arrive to a sound of their own. One
 * draft for all of it, saved with one button, so a half-made change never
 * reaches the players.
 */

import { useGameText } from "../game-text";
import type { GameKey } from "../../../messages";
import { LevelSlider, soundUrl } from "./sounds-parts";
import { Plus, Play, Square, Trash2 } from "lucide-react";
import { saveSoundSettingsAction } from "./sounds-actions";
import { useEffect, useMemo, useState, useTransition } from "react";
import type { SoundEntry } from "../../lib/minecraft/sounds-service";
import { Button, Card, CardBody, Input, Select, Switch } from "@polaris/ui";
import * as rules from "../../lib/minecraft/sounds";

type Moment = rules.Moment;
type PlayerSound = rules.PlayerSound;
type SoundSettings = rules.SoundSettings;
type SoundUse = rules.SoundUse;

const PLAYER = /^[A-Za-z0-9_]{1,16}$/;
const NONE = "";

const MOMENT_WORDS: Readonly<Record<Moment, readonly [GameKey<"minecraft">, GameKey<"minecraft">]>> = {
    countdown: ["sounds.moments.countdown", "sounds.moments.countdownHint"],
    start: ["sounds.moments.start", "sounds.moments.startHint"],
    win: ["sounds.moments.win", "sounds.moments.winHint"],
    horn: ["sounds.moments.horn", "sounds.moments.hornHint"],
    boss: ["sounds.moments.boss", "sounds.moments.bossHint"],
    join: ["sounds.moments.join", "sounds.moments.joinHint"],
    welcome: ["sounds.moments.welcome", "sounds.moments.welcomeHint"]
};

type Preview = {
    playing: string | null;
    play: (id: string, url: string, volume?: number, pitch?: number) => void;
    stop: () => void;
};

function same(a: SoundSettings, b: SoundSettings): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

export function SoundSettingsEditor({
    installedAppId,
    sounds,
    settings,
    canManage,
    jar,
    preview,
    onSaved
}: {
    installedAppId: string;
    sounds: readonly SoundEntry[];
    settings: SoundSettings;
    canManage: boolean;
    /** Whether Polaris's mod or plugin hands the pack out on this server: the
     *  join moments are played by it, so without it they do nothing. */
    jar: boolean;
    preview: Preview;
    onSaved: (settings: SoundSettings, pushed: boolean) => void;
}) {
    const t = useGameText("minecraft");
    const [draft, setDraft] = useState<SoundSettings>(settings);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    // A fresh read replaces the draft only while nothing is being edited.
    const [base, setBase] = useState(settings);
    useEffect(() => {
        if (!same(settings, base)) {
            setDraft((current) => (same(current, base) ? settings : current));
            setBase(settings);
        }
    }, [settings, base]);

    const byKey = useMemo(() => new Map(sounds.map((entry) => [entry.key, entry])), [sounds]);
    const options = useMemo(
        () => [...sounds].sort((a, b) => a.name.localeCompare(b.name)).map((entry) => ({ value: entry.key, label: entry.name })),
        [sounds]
    );
    const dirty = !same(draft, settings);
    const badPlayers = draft.players.some((one) => !PLAYER.test(one.player.trim()));
    const repeated = new Set<string>();
    const duplicate = draft.players.some((one) => {
        const name = one.player.trim().toLowerCase();
        if (repeated.has(name)) return true;
        repeated.add(name);
        return false;
    });
    const disabled = !canManage || pending;

    function setMoment(moment: Moment, use: SoundUse | null): void {
        setNote(null);
        setDraft((current) => {
            const moments = { ...current.moments };
            if (use) moments[moment] = use;
            else delete moments[moment];
            return { ...current, moments };
        });
    }

    function setPlayer(at: number, change: Partial<PlayerSound>): void {
        setNote(null);
        setDraft((current) => ({
            ...current,
            players: current.players.map((one, index) => (index === at ? { ...one, ...change } : one))
        }));
    }

    function listen(id: string, use: SoundUse): void {
        const entry = byKey.get(use.sound);
        if (!entry) return;
        if (preview.playing === id) preview.stop();
        else preview.play(id, soundUrl(installedAppId, entry.id, entry.updatedAt), use.volume, use.pitch);
    }

    function save(): void {
        if (!dirty || badPlayers || duplicate) return;
        setError(null);
        setNote(null);
        const next: SoundSettings = {
            ...draft,
            prompt: draft.prompt.trim(),
            players: draft.players.map((one) => ({ ...one, player: one.player.trim() }))
        };
        startTransition(async () => {
            const result = await saveSoundSettingsAction({ installedAppId, settings: next });
            if (result.error) {
                setError(result.error);
                return;
            }
            setDraft(next);
            setNote(result.pushed ? t("sounds.pushed") : t("sounds.moments.saved"));
            onSaved(next, result.pushed ?? false);
        });
    }

    function momentRow(moment: Moment, needsJar: boolean) {
        const use = draft.moments[moment] ?? null;
        const off = disabled || needsJar;
        const id = `moment:${moment}`;
        return (
            <li key={moment} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1 basis-48">
                        <p className="text-sm">{t(MOMENT_WORDS[moment][0])}</p>
                        <p className="text-xs text-muted-foreground">{t(MOMENT_WORDS[moment][1])}</p>
                    </div>
                    <div className="flex min-w-0 items-center gap-2">
                        <Select
                            className="w-48 max-w-full"
                            value={use?.sound ?? NONE}
                            disabled={off || sounds.length === 0}
                            onValueChange={(key) =>
                                setMoment(moment, key === NONE ? null : { sound: key, volume: use?.volume ?? 1, pitch: use?.pitch ?? 1 })
                            }
                            options={[
                                {
                                    value: NONE,
                                    label: rules.EVENT_MOMENTS.includes(moment as (typeof rules.EVENT_MOMENTS)[number])
                                        ? t("sounds.moments.gameSound")
                                        : t("sounds.moments.none")
                                },
                                ...options
                            ]}
                            aria-label={t(MOMENT_WORDS[moment][0])}
                        />
                        <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            disabled={!use || !byKey.has(use.sound)}
                            onClick={() => use && listen(id, use)}
                            aria-label={preview.playing === id ? t("sounds.library.stop") : t("sounds.moments.listen")}
                            title={preview.playing === id ? t("sounds.library.stop") : t("sounds.moments.listen")}
                        >
                            {preview.playing === id ? <Square className="size-4" /> : <Play className="size-4" />}
                        </Button>
                    </div>
                </div>
                {use ? (
                    <div className="grid grid-cols-2 gap-3">
                        <LevelSlider
                            label={t("sounds.moments.volume")}
                            value={use.volume}
                            min={0}
                            max={1}
                            step={0.05}
                            disabled={off}
                            onChange={(volume) => setMoment(moment, { ...use, volume })}
                        />
                        <LevelSlider
                            label={t("sounds.moments.pitch")}
                            value={use.pitch}
                            min={rules.MIN_PITCH}
                            max={rules.MAX_PITCH}
                            step={0.05}
                            disabled={off}
                            onChange={(pitch) => setMoment(moment, { ...use, pitch })}
                        />
                    </div>
                ) : null}
            </li>
        );
    }

    const saveBar = (
        <div className="flex flex-wrap items-center justify-end gap-3">
            {note ? <p className="mr-auto text-xs text-muted-foreground">{note}</p> : null}
            {error ? (
                <p role="alert" className="mr-auto text-xs text-danger">
                    {error}
                </p>
            ) : null}
            {canManage ? (
                <Button type="button" disabled={pending || !dirty || badPlayers || duplicate} onClick={save}>
                    {t("sounds.moments.save")}
                </Button>
            ) : null}
        </div>
    );

    return (
        <>
            <Card>
                <CardBody className="flex flex-col gap-3">
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <p className="text-sm font-medium">{t("sounds.required")}</p>
                            <p className="text-xs text-muted-foreground">{t("sounds.requiredHint")}</p>
                        </div>
                        <Switch
                            checked={draft.required}
                            disabled={disabled}
                            onChange={(required) => {
                                setNote(null);
                                setDraft((current) => ({ ...current, required }));
                            }}
                            aria-label={t("sounds.required")}
                        />
                    </div>
                    <label className="flex flex-col gap-1 text-sm">
                        <span>{t("sounds.prompt")}</span>
                        <Input
                            value={draft.prompt}
                            maxLength={rules.MAX_PROMPT}
                            disabled={disabled}
                            placeholder={t("sounds.promptPlaceholder")}
                            onChange={(event) => {
                                setNote(null);
                                const prompt = event.target.value;
                                setDraft((current) => ({ ...current, prompt }));
                            }}
                        />
                        <span className="text-xs text-muted-foreground">{t("sounds.promptHint")}</span>
                    </label>
                </CardBody>
            </Card>

            <Card>
                <CardBody className="flex flex-col gap-3">
                    <div>
                        <p className="text-sm font-medium">{t("sounds.moments.title")}</p>
                        <p className="text-xs text-muted-foreground">{t("sounds.moments.hint")}</p>
                    </div>
                    <ul className="flex flex-col divide-y divide-border">
                        {rules.EVENT_MOMENTS.map((moment) => momentRow(moment, false))}
                        {rules.SERVER_MOMENTS.map((moment) => momentRow(moment, !jar))}
                    </ul>
                    {!jar ? <p className="text-xs text-muted-foreground">{t("sounds.moments.needsJar")}</p> : null}
                </CardBody>
            </Card>

            <Card>
                <CardBody className="flex flex-col gap-3">
                    <div>
                        <p className="text-sm font-medium">{t("sounds.players.title")}</p>
                        <p className="text-xs text-muted-foreground">{t("sounds.players.hint")}</p>
                    </div>
                    {draft.players.length === 0 ? (
                        <p className="text-xs text-muted-foreground">{t("sounds.players.empty")}</p>
                    ) : (
                        <ul className="flex flex-col divide-y divide-border">
                            {draft.players.map((one, at) => {
                                const id = `player:${at}`;
                                const bad = one.player.trim() !== "" && !PLAYER.test(one.player.trim());
                                return (
                                    <li key={at} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <Input
                                                className="w-40 min-w-0"
                                                value={one.player}
                                                maxLength={16}
                                                spellCheck={false}
                                                disabled={disabled || !jar}
                                                placeholder={t("sounds.players.player")}
                                                aria-label={t("sounds.players.player")}
                                                aria-invalid={bad}
                                                onChange={(event) => setPlayer(at, { player: event.target.value })}
                                            />
                                            <Select
                                                className="w-48 max-w-full"
                                                value={byKey.has(one.sound) ? one.sound : NONE}
                                                disabled={disabled || !jar}
                                                placeholder={t("sounds.players.sound")}
                                                onValueChange={(sound) => sound !== NONE && setPlayer(at, { sound })}
                                                options={options}
                                                aria-label={t("sounds.players.sound")}
                                            />
                                            <Button
                                                type="button"
                                                size="icon"
                                                variant="ghost"
                                                disabled={!byKey.has(one.sound)}
                                                onClick={() => listen(id, one)}
                                                aria-label={preview.playing === id ? t("sounds.library.stop") : t("sounds.moments.listen")}
                                                title={preview.playing === id ? t("sounds.library.stop") : t("sounds.moments.listen")}
                                            >
                                                {preview.playing === id ? <Square className="size-4" /> : <Play className="size-4" />}
                                            </Button>
                                            <Button
                                                type="button"
                                                size="icon"
                                                variant="ghost"
                                                disabled={disabled}
                                                onClick={() => {
                                                    setNote(null);
                                                    setDraft((current) => ({
                                                        ...current,
                                                        players: current.players.filter((_, index) => index !== at)
                                                    }));
                                                }}
                                                aria-label={t("sounds.players.remove")}
                                                title={t("sounds.players.remove")}
                                            >
                                                <Trash2 className="size-4" />
                                            </Button>
                                        </div>
                                        {bad ? <p className="text-xs text-danger">{t("sounds.players.badName")}</p> : null}
                                        <div className="grid grid-cols-2 gap-3">
                                            <LevelSlider
                                                label={t("sounds.moments.volume")}
                                                value={one.volume}
                                                min={0}
                                                max={1}
                                                step={0.05}
                                                disabled={disabled || !jar}
                                                onChange={(volume) => setPlayer(at, { volume })}
                                            />
                                            <LevelSlider
                                                label={t("sounds.moments.pitch")}
                                                value={one.pitch}
                                                min={rules.MIN_PITCH}
                                                max={rules.MAX_PITCH}
                                                step={0.05}
                                                disabled={disabled || !jar}
                                                onChange={(pitch) => setPlayer(at, { pitch })}
                                            />
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                    {duplicate ? <p className="text-xs text-danger">{t("sounds.players.duplicate")}</p> : null}
                    <div>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={disabled || !jar || options.length === 0 || draft.players.length >= rules.MAX_PLAYER_SOUNDS}
                            onClick={() => {
                                setNote(null);
                                setDraft((current) => ({
                                    ...current,
                                    players: [...current.players, { player: "", sound: options[0]!.value, volume: 1, pitch: 1 }]
                                }));
                            }}
                        >
                            <Plus className="size-4" /> {t("sounds.players.add")}
                        </Button>
                    </div>
                    {!jar ? <p className="text-xs text-muted-foreground">{t("sounds.moments.needsJar")}</p> : null}
                </CardBody>
            </Card>
            {saveBar}
        </>
    );
}
