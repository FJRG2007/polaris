"use client";

/**
 * The two dialogs a sound in the library opens: editing what the pack says
 * about it, and playing it to the players now.
 */

import { useGameText } from "../game-text";
import { LevelSlider } from "./sounds-parts";
import { useEffect, useState, useTransition } from "react";
import type { SoundEntry } from "../../lib/minecraft/sounds-service";
import { playSoundAction, updateSoundAction } from "./sounds-actions";
import {
    MAX_NAME,
    MAX_PITCH,
    MAX_SUBTITLE,
    MIN_PITCH,
    normalizeVanillaId,
    soundId,
    soundKey
} from "../../lib/minecraft/sounds";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Switch
} from "@polaris/ui";

const VANILLA = /^minecraft:[a-z0-9_.-]{1,120}$/;

export function SoundEditDialog({
    installedAppId,
    sound,
    onClose,
    onSaved
}: {
    installedAppId: string;
    sound: SoundEntry | null;
    onClose: () => void;
    onSaved: (note: string) => void;
}) {
    const t = useGameText("minecraft");
    const [name, setName] = useState("");
    const [subtitle, setSubtitle] = useState("");
    const [replaces, setReplaces] = useState("");
    const [stream, setStream] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    useEffect(() => {
        if (!sound) return;
        setName(sound.name);
        setSubtitle(sound.subtitle);
        setReplaces(sound.replaces);
        setStream(sound.stream);
        setError(null);
    }, [sound]);

    if (!sound) return null;
    const nameOk = soundKey(name).length > 0;
    const replacesValue = normalizeVanillaId(replaces);
    const replacesOk = replacesValue === "" || VANILLA.test(replacesValue);
    const dirty =
        name.trim() !== sound.name ||
        subtitle.trim() !== sound.subtitle ||
        replacesValue !== sound.replaces ||
        stream !== sound.stream;

    function save(): void {
        if (!sound || !dirty || !nameOk || !replacesOk) return;
        setError(null);
        startTransition(async () => {
            const result = await updateSoundAction({
                installedAppId,
                soundId: sound.id,
                name,
                subtitle,
                replaces: replacesValue,
                stream
            });
            if (result.error) {
                setError(result.error);
                return;
            }
            onSaved(result.pushed ? t("sounds.pushed") : t("sounds.editor.saved"));
        });
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("sounds.editor.title")}</DialogTitle>
                    <DialogDescription>
                        {t("sounds.editor.id")}:{" "}
                        <code className="break-all">{soundId(sound.key)}</code>
                    </DialogDescription>
                </DialogHeader>
                <form
                    className="flex flex-col gap-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        save();
                    }}
                >
                    <label className="flex flex-col gap-1 text-sm">
                        <span>{t("sounds.editor.name")} *</span>
                        <Input
                            value={name}
                            maxLength={MAX_NAME}
                            onChange={(event) => setName(event.target.value)}
                            aria-invalid={!nameOk && name.length > 0}
                        />
                        {!nameOk && name.length > 0 ? (
                            <span className="text-xs text-danger">{t("sounds.refused.name")}</span>
                        ) : null}
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        <span>{t("sounds.editor.subtitle")}</span>
                        <Input
                            value={subtitle}
                            maxLength={MAX_SUBTITLE}
                            onChange={(event) => setSubtitle(event.target.value)}
                        />
                        <span className="text-xs text-muted-foreground">
                            {t("sounds.editor.subtitleHint")}
                        </span>
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        <span>{t("sounds.editor.replaces")}</span>
                        <Input
                            value={replaces}
                            maxLength={130}
                            spellCheck={false}
                            placeholder="minecraft:music_disc.cat" // i18n-ignore: a game id
                            onChange={(event) => setReplaces(event.target.value)}
                            aria-invalid={!replacesOk}
                        />
                        <span
                            className={
                                replacesOk ? "text-xs text-muted-foreground" : "text-xs text-danger"
                            }
                        >
                            {replacesOk
                                ? t("sounds.editor.replacesHint")
                                : t("sounds.refused.vanilla")}
                        </span>
                    </label>
                    <div className="flex items-start justify-between gap-3 text-sm">
                        <div className="min-w-0">
                            <p>{t("sounds.editor.stream")}</p>
                            <p className="text-xs text-muted-foreground">
                                {t("sounds.editor.streamHint")}
                            </p>
                        </div>
                        <Switch
                            checked={stream}
                            onChange={setStream}
                            aria-label={t("sounds.editor.stream")}
                        />
                    </div>
                    {error ? (
                        <p role="alert" className="text-xs text-danger">
                            {error}
                        </p>
                    ) : null}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            {t("sounds.editor.cancel")}
                        </Button>
                        <Button
                            type="submit"
                            disabled={pending || !dirty || !nameOk || !replacesOk}
                        >
                            {t("sounds.editor.save")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

const EVERYBODY = "@everybody";

export function SoundPlayDialog({
    installedAppId,
    sound,
    players,
    onClose
}: {
    installedAppId: string;
    sound: SoundEntry | null;
    players: readonly string[];
    onClose: () => void;
}) {
    const t = useGameText("minecraft");
    const [target, setTarget] = useState(EVERYBODY);
    const [volume, setVolume] = useState(1);
    const [pitch, setPitch] = useState(1);
    const [note, setNote] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    useEffect(() => {
        setNote(null);
        setError(null);
    }, [sound]);

    if (!sound) return null;
    const options = [
        { value: EVERYBODY, label: t("sounds.play.everybody") },
        ...[...players]
            .sort((a, b) => a.localeCompare(b))
            .map((name) => ({ value: name, label: name }))
    ];

    function play(): void {
        if (!sound) return;
        setNote(null);
        setError(null);
        startTransition(async () => {
            const result = await playSoundAction({
                installedAppId,
                key: sound.key,
                player: target === EVERYBODY ? null : target,
                volume,
                pitch
            });
            if (result.error) setError(result.error);
            else setNote(t("sounds.play.played"));
        });
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle className="truncate">
                        {t("sounds.play.title", { name: sound.name })}
                    </DialogTitle>
                    <DialogDescription>{t("sounds.play.note")}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        <span>{t("sounds.play.to")}</span>
                        <Select
                            value={
                                players.includes(target) || target === EVERYBODY
                                    ? target
                                    : EVERYBODY
                            }
                            onValueChange={setTarget}
                            options={options}
                            aria-label={t("sounds.play.to")}
                        />
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                        <LevelSlider
                            label={t("sounds.play.volume")}
                            value={volume}
                            min={0}
                            max={1}
                            step={0.05}
                            onChange={setVolume}
                        />
                        <LevelSlider
                            label={t("sounds.play.pitch")}
                            value={pitch}
                            min={MIN_PITCH}
                            max={MAX_PITCH}
                            step={0.05}
                            onChange={setPitch}
                        />
                    </div>
                    {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
                    {error ? (
                        <p role="alert" className="text-xs text-danger">
                            {error}
                        </p>
                    ) : null}
                </div>
                <DialogFooter>
                    <Button type="button" variant="ghost" onClick={onClose}>
                        {t("sounds.play.cancel")}
                    </Button>
                    <Button type="button" disabled={pending} onClick={play}>
                        {t("sounds.play.play")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
