"use client";

/**
 * A space's soundboard: its sounds, where it is switched on, and who may not use
 * it.
 *
 * Laid out after Discord's Soundboard page and the two permissions that govern
 * it there - "Use Soundboard" and "Use External Sounds" - folded into the role
 * model a space here has. A sound is uploaded from any audio file the browser
 * can play, cut to at most 5.2 seconds where it is longer, and given a name, an
 * emoji and a volume of its own.
 *
 * Only whoever runs the space reaches this page; the server refuses everybody
 * else, and the page says so rather than drawing controls that would fail.
 * Every switch moves at once and is put back if the server disagrees.
 */

import Link from "next/link";
import * as rules from "@/lib/chat/soundboard";
import { useChat } from "@/app/(app)/chat/chat-context";
import { PeoplePicker } from "@/components/people-picker";
import { EmojiPicker } from "@/app/(app)/chat/emoji-picker";
import { SOUND_GLYPH } from "@/app/(app)/chat/call-signals";
import { searchPeopleAction } from "@/app/(app)/chat/actions";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { previewSound } from "@/app/(app)/chat/soundboard-player";
import type { SoundView, SpaceSoundboard } from "@/lib/chat/soundboard-service";
import { ArrowLeft, Hash, Loader2, Music2, Pencil, Trash2, Upload, Volume2, X } from "lucide-react";
import {
    cutSound,
    decodeSound,
    nameFromFile,
    SOUND_ACCEPT,
    type DecodedSound
} from "@/app/(app)/chat/soundboard-upload";
import {
    Button,
    ConfirmDeleteDialog,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select,
    Skeleton,
    Switch
} from "@polaris/ui";
import * as actions from "@/app/(app)/chat/soundboard-actions";

/** Seconds, one decimal, the way a clip's length is read. */
function seconds(ms: number): string {
    return (ms / 1000).toFixed(1);
}

export function SpaceSoundboardView({ spaceId }: { spaceId: string }) {
    const t = useTranslations("chat");
    const { spaces } = useChat();
    const space = spaces.find((entry) => entry.id === spaceId) ?? null;
    const [board, setBoard] = useState<SpaceSoundboard | null>(null);
    const [failed, setFailed] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [editing, setEditing] = useState<SoundView | "new" | null>(null);
    const [deleting, setDeleting] = useState<SoundView | null>(null);
    const [deletePending, setDeletePending] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);

    const load = useCallback(() => {
        void actions.spaceSoundboardAction(spaceId).then((answer) => {
            if (answer.board) {
                setBoard(answer.board);
                setFailed(null);
            } else setFailed(answer.error ?? t("errors.notDone"));
        });
    }, [spaceId, t]);
    useEffect(load, [load]);

    /** Change the board here at once, ask the server, and put it back if it
     *  says no. */
    const optimistic = async (
        change: (current: SpaceSoundboard) => SpaceSoundboard,
        ask: () => Promise<{ error?: string }>
    ) => {
        if (!board) return;
        const before = board;
        setBoard(change(board));
        setError(null);
        const answer = await ask().catch(() => ({ error: t("errors.notDone") }));
        if (answer.error) {
            setBoard(before);
            setError(answer.error);
        }
    };

    const remove = async () => {
        if (!deleting) return;
        setDeletePending(true);
        setDeleteError(null);
        const answer = await actions.deleteSoundAction({ soundId: deleting.id }).catch(() => ({
            error: t("errors.notDone")
        }));
        setDeletePending(false);
        if (answer.error) {
            setDeleteError(answer.error);
            return;
        }
        setBoard((current) =>
            current
                ? { ...current, sounds: current.sounds.filter((one) => one.id !== deleting.id) }
                : current
        );
        setDeleting(null);
    };

    const spaceName = board?.spaceName ?? space?.name ?? "";
    const full = (board?.sounds.length ?? 0) >= rules.SOUNDBOARD_SLOTS;
    const deniedSubjects = new Set(board?.denials.map((denial) => denial.subject) ?? []);
    const roleName = (subject: string, name: string | null) =>
        subject === "member"
            ? t("soundboardSettings.roleMember")
            : subject === "admin"
              ? t("soundboardSettings.roleAdmin")
              : (name ?? subject.replace(rules.ORG_ROLE_PREFIX, ""));

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex h-header shrink-0 items-center gap-2 border-b border-border px-3">
                <Link
                    href="/chat"
                    aria-label={t("soundboardSettings.back")}
                    className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:hidden"
                >
                    <ArrowLeft className="size-4" />
                </Link>
                <Music2 className="size-4 shrink-0 text-primary" />
                <span className="shrink-0 text-sm font-semibold">{t("soundboardSettings.title")}</span>
                {spaceName && (
                    <span className="min-w-0 truncate text-sm text-muted-foreground" title={spaceName}>
                        {spaceName}
                    </span>
                )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4">
                    <p className="text-sm text-muted-foreground">{t("soundboardSettings.intro")}</p>

                    {failed ? (
                        <p className="rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground" role="alert">
                            {failed}
                        </p>
                    ) : null}
                    {error && (
                        <p className="text-sm text-danger" role="alert">
                            {error}
                        </p>
                    )}

                    {/* The two switches that decide everything below. */}
                    <section className="flex flex-col gap-2">
                        <h2 className="text-sm font-medium">{t("soundboardSettings.switches")}</h2>
                        {board === null && !failed ? (
                            <Skeleton className="h-24 w-full" />
                        ) : board ? (
                            <div className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
                                <SwitchRow
                                    label={t("soundboardSettings.enabled")}
                                    hint={t("soundboardSettings.enabledHint")}
                                    checked={board.enabled}
                                    onChange={(enabled) =>
                                        void optimistic(
                                            (current) => ({ ...current, enabled }),
                                            () => actions.setSpaceSoundboardAction({ spaceId, enabled })
                                        )
                                    }
                                />
                                <SwitchRow
                                    label={t("soundboardSettings.external")}
                                    hint={t("soundboardSettings.externalHint")}
                                    checked={board.external}
                                    disabled={!board.enabled}
                                    onChange={(external) =>
                                        void optimistic(
                                            (current) => ({ ...current, external }),
                                            () => actions.setSpaceSoundboardAction({ spaceId, external })
                                        )
                                    }
                                />
                            </div>
                        ) : null}
                    </section>

                    {/* The sounds. */}
                    <section className="flex flex-col gap-2">
                        <div className="flex items-center justify-between gap-2">
                            <h2 className="text-sm font-medium">
                                {t("soundboardSettings.sounds", {
                                    count: board?.sounds.length ?? 0,
                                    total: rules.SOUNDBOARD_SLOTS
                                })}
                            </h2>
                            <Button size="sm" disabled={!board || full} onClick={() => setEditing("new")}>
                                <Upload className="size-3.5" />
                                {t("soundboardSettings.upload")}
                            </Button>
                        </div>
                        <p className="text-xs text-muted-foreground">{t("soundboardSettings.rules")}</p>
                        {full && <p className="text-xs text-muted-foreground">{t("soundboardSettings.full")}</p>}
                        {board === null && !failed ? (
                            <Skeleton className="h-32 w-full" />
                        ) : board && board.sounds.length === 0 ? (
                            <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                                {t("soundboardSettings.none")}
                            </p>
                        ) : board ? (
                            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
                                {board.sounds.map((sound) => (
                                    <li key={sound.id} className="flex min-w-0 items-center gap-3 px-3 py-2">
                                        <span aria-hidden className="w-6 shrink-0 text-center text-lg">
                                            {sound.emoji || SOUND_GLYPH}
                                        </span>
                                        <div className="flex min-w-0 flex-1 flex-col">
                                            <span className="truncate text-sm" title={sound.name}>
                                                {sound.name}
                                            </span>
                                            <span className="truncate text-xs text-muted-foreground">
                                                {t("soundboardSettings.details", {
                                                    seconds: seconds(sound.durationMs),
                                                    volume: Math.round(sound.volume * 100)
                                                })}
                                                {sound.uploaderName
                                                    ? ` - ${t("soundboardSettings.by", { name: sound.uploaderName })}`
                                                    : ""}
                                            </span>
                                        </div>
                                        <IconButton
                                            label={t("soundboard.preview", { name: sound.name })}
                                            onClick={() => void previewSound(sound.id, sound.volume)}
                                        >
                                            <Volume2 className="size-4" />
                                        </IconButton>
                                        <IconButton
                                            label={t("soundboardSettings.edit", { name: sound.name })}
                                            onClick={() => setEditing(sound)}
                                        >
                                            <Pencil className="size-4" />
                                        </IconButton>
                                        <IconButton
                                            label={t("soundboardSettings.delete", { name: sound.name })}
                                            onClick={() => {
                                                setDeleteError(null);
                                                setDeleting(sound);
                                            }}
                                        >
                                            <Trash2 className="size-4" />
                                        </IconButton>
                                    </li>
                                ))}
                            </ul>
                        ) : null}
                    </section>

                    {/* Each conversation, on or off. */}
                    {board && board.channels.length > 0 && (
                        <section className="flex flex-col gap-2">
                            <h2 className="text-sm font-medium">{t("soundboardSettings.channels")}</h2>
                            <p className="text-xs text-muted-foreground">
                                {t("soundboardSettings.channelsHint")}
                            </p>
                            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
                                {board.channels.map((channel) => (
                                    <li key={channel.id} className="flex min-w-0 items-center gap-2 px-3 py-2">
                                        {channel.kind === "voice" ? (
                                            <Volume2 className="size-4 shrink-0 text-muted-foreground" />
                                        ) : (
                                            <Hash className="size-4 shrink-0 text-muted-foreground" />
                                        )}
                                        <Link
                                            href={`/chat/c/${channel.id}`}
                                            className="min-w-0 flex-1 truncate text-sm hover:underline"
                                            title={channel.name}
                                        >
                                            {channel.name}
                                        </Link>
                                        <Switch
                                            checked={channel.enabled && board.enabled}
                                            disabled={!board.enabled}
                                            aria-label={t("soundboardSettings.inChannel", { name: channel.name })}
                                            onChange={(enabled) =>
                                                void optimistic(
                                                    (current) => ({
                                                        ...current,
                                                        channels: current.channels.map((one) =>
                                                            one.id === channel.id ? { ...one, enabled } : one
                                                        )
                                                    }),
                                                    () =>
                                                        actions.setChannelSoundboardAction({
                                                            channelId: channel.id,
                                                            enabled
                                                        })
                                                )
                                            }
                                        />
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}

                    {/* Who may not. */}
                    {board && (
                        <section className="flex flex-col gap-2">
                            <h2 className="text-sm font-medium">{t("soundboardSettings.denied")}</h2>
                            <p className="text-xs text-muted-foreground">{t("soundboardSettings.deniedHint")}</p>
                            {board.denials.length > 0 && (
                                <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
                                    {board.denials.map((denial) => {
                                        const name =
                                            denial.kind === "role"
                                                ? roleName(denial.subject, denial.name)
                                                : (denial.name ?? t("soundboardSettings.unknownPerson"));
                                        return (
                                            <li
                                                key={`${denial.kind}:${denial.subject}`}
                                                className="flex min-w-0 items-center gap-2 px-3 py-2"
                                            >
                                                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground">
                                                    {denial.kind === "role"
                                                        ? t("soundboardSettings.role")
                                                        : t("soundboardSettings.person")}
                                                </span>
                                                <span className="min-w-0 flex-1 truncate text-sm" title={name}>
                                                    {name}
                                                </span>
                                                <IconButton
                                                    label={t("soundboardSettings.allow", { name })}
                                                    onClick={() =>
                                                        void optimistic(
                                                            (current) => ({
                                                                ...current,
                                                                denials: current.denials.filter(
                                                                    (one) =>
                                                                        !(one.kind === denial.kind && one.subject === denial.subject)
                                                                )
                                                            }),
                                                            () =>
                                                                actions.setSoundDenialAction({
                                                                    spaceId,
                                                                    denial: { kind: denial.kind, subject: denial.subject },
                                                                    denied: false
                                                                })
                                                        )
                                                    }
                                                >
                                                    <X className="size-4" />
                                                </IconButton>
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                                <div className="flex min-w-0 flex-1 flex-col gap-1">
                                    <span className="text-xs text-muted-foreground">
                                        {t("soundboardSettings.denyRole")}
                                    </span>
                                    <Select
                                        value=""
                                        placeholder={t("soundboardSettings.pickRole")}
                                        aria-label={t("soundboardSettings.denyRole")}
                                        options={board.roles
                                            .filter((role) => !deniedSubjects.has(role.subject))
                                            .map((role) => ({
                                                value: role.subject,
                                                label: roleName(role.subject, role.name)
                                            }))}
                                        onValueChange={(subject) => {
                                            const role = board.roles.find((one) => one.subject === subject);
                                            if (!role) return;
                                            void optimistic(
                                                (current) => ({
                                                    ...current,
                                                    denials: [
                                                        ...current.denials,
                                                        { kind: "role", subject, name: role.name } as SpaceSoundboard["denials"][number]
                                                    ]
                                                }),
                                                () =>
                                                    actions.setSoundDenialAction({
                                                        spaceId,
                                                        denial: { kind: "role", subject },
                                                        denied: true
                                                    })
                                            );
                                        }}
                                    />
                                </div>
                                <div className="flex min-w-0 flex-1 flex-col gap-1">
                                    <span className="text-xs text-muted-foreground">
                                        {t("soundboardSettings.denyPerson")}
                                    </span>
                                    <PeoplePicker
                                        picked={[]}
                                        exclude={board.denials
                                            .filter((denial) => denial.kind === "user")
                                            .map((denial) => denial.subject)}
                                        search={searchPeopleAction}
                                        label={t("soundboardSettings.denyPerson")}
                                        onChange={(picked) => {
                                            const person = picked[0];
                                            if (!person) return;
                                            void optimistic(
                                                (current) => ({
                                                    ...current,
                                                    denials: [
                                                        ...current.denials,
                                                        {
                                                            kind: "user",
                                                            subject: person.id,
                                                            name: person.name
                                                        }
                                                    ]
                                                }),
                                                () =>
                                                    actions.setSoundDenialAction({
                                                        spaceId,
                                                        denial: { kind: "user", subject: person.id },
                                                        denied: true
                                                    })
                                            );
                                        }}
                                    />
                                </div>
                            </div>
                        </section>
                    )}
                </div>
            </div>

            <SoundDialog
                spaceId={spaceId}
                editing={editing}
                onClose={() => setEditing(null)}
                onSaved={(sound) => {
                    setBoard((current) => {
                        if (!current) return current;
                        const exists = current.sounds.some((one) => one.id === sound.id);
                        return {
                            ...current,
                            sounds: exists
                                ? current.sounds.map((one) => (one.id === sound.id ? sound : one))
                                : [...current.sounds, sound]
                        };
                    });
                    setEditing(null);
                }}
            />

            <ConfirmDeleteDialog
                open={deleting !== null}
                onOpenChange={(open) => !open && setDeleting(null)}
                requireTyping={false}
                name={deleting?.name ?? ""}
                kind=""
                title={t("soundboardSettings.deleteTitle")}
                question={t("soundboardSettings.deleteQuestion", { name: deleting?.name ?? "" })}
                description={t("soundboardSettings.deleteBody")}
                confirmLabel={t("soundboardSettings.deleteConfirm")}
                error={deleteError}
                pending={deletePending}
                onConfirm={() => void remove()}
            />
        </div>
    );
}

function SwitchRow({
    label,
    hint,
    checked,
    disabled = false,
    onChange
}: {
    label: string;
    hint: string;
    checked: boolean;
    disabled?: boolean;
    onChange: (checked: boolean) => void;
}) {
    return (
        <div className="flex items-start gap-3 px-3 py-2.5">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm">{label}</span>
                <span className="text-xs text-muted-foreground">{hint}</span>
            </div>
            <Switch checked={checked} disabled={disabled} onChange={onChange} aria-label={label} />
        </div>
    );
}

function IconButton({
    label,
    onClick,
    children
}: {
    label: string;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-label={label}
            title={label}
            className="shrink-0 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
            {children}
        </button>
    );
}

/**
 * Upload a sound, or change one's name, emoji and volume.
 *
 * A new sound starts from a file. Anything longer than 5.2 seconds gets a
 * slider for where the clip starts, and the clip can be heard before it is
 * saved - which is the only way anybody can tell whether they cut it in the
 * right place.
 */
function SoundDialog({
    spaceId,
    editing,
    onClose,
    onSaved
}: {
    spaceId: string;
    editing: SoundView | "new" | null;
    onClose: () => void;
    onSaved: (sound: SoundView) => void;
}) {
    const t = useTranslations("chat");
    const chooser = useRef<HTMLInputElement>(null);
    const [file, setFile] = useState<File | null>(null);
    const [decoded, setDecoded] = useState<DecodedSound | null>(null);
    const [decoding, setDecoding] = useState(false);
    const [startMs, setStartMs] = useState(0);
    const [name, setName] = useState("");
    const [emoji, setEmoji] = useState("");
    const [volume, setVolume] = useState(1);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [nameTouched, setNameTouched] = useState(false);
    const preview = useRef<HTMLAudioElement | null>(null);

    const open = editing !== null;
    const isNew = editing === "new";
    useEffect(() => {
        if (!open) return;
        setFile(null);
        setDecoded(null);
        setStartMs(0);
        setError(null);
        setSaving(false);
        setNameTouched(false);
        if (editing && editing !== "new") {
            setName(editing.name);
            setEmoji(editing.emoji);
            setVolume(editing.volume);
        } else {
            setName("");
            setEmoji("");
            setVolume(1);
        }
    }, [open, editing]);

    const choose = async (chosen: File | undefined) => {
        if (!chosen) return;
        setFile(chosen);
        setDecoded(null);
        setError(null);
        setDecoding(true);
        const answer = await decodeSound(chosen);
        setDecoding(false);
        if (!answer.sound) {
            setError(
                answer.failure === "tooLarge"
                    ? t("soundboardSettings.fileTooLarge")
                    : t("soundboardSettings.fileUnreadable")
            );
            return;
        }
        setDecoded(answer.sound);
        setStartMs(0);
        if (!nameTouched) setName(nameFromFile(chosen, rules.SOUND_NAME_MAX));
    };

    const listen = async () => {
        if (!decoded) return;
        const bytes = await cutSound(decoded, startMs);
        preview.current?.pause();
        const element = new Audio(URL.createObjectURL(new Blob([bytes as BlobPart], { type: "audio/wav" })));
        element.volume = volume;
        preview.current = element;
        void element.play().catch(() => undefined);
    };

    const parsedName = rules.soundNameSchema.safeParse(name);
    const nameError =
        nameTouched && !parsedName.success
            ? parsedName.error.issues[0]?.message === "long"
                ? t("errors.soundNameLong")
                : t("errors.soundNameShort")
            : null;
    const ready = parsedName.success && (!isNew || decoded !== null) && !saving;
    const longer = decoded !== null && decoded.durationMs > rules.SOUND_MAX_MS;

    const save = async () => {
        if (!ready || !editing) return;
        setSaving(true);
        setError(null);
        try {
            if (editing === "new") {
                if (!decoded || !file) return;
                const bytes = await cutSound(decoded, startMs);
                const form = new FormData();
                form.set("spaceId", spaceId);
                form.set("name", name);
                form.set("emoji", emoji);
                form.set("volume", String(volume));
                form.set("file", new Blob([bytes as BlobPart], { type: "audio/wav" }), "sound.wav");
                const answer = await actions.uploadSoundAction(form);
                if (answer.sound) onSaved(answer.sound);
                else setError(answer.error ?? t("errors.notDone"));
            } else {
                const answer = await actions.updateSoundAction({
                    soundId: editing.id,
                    name,
                    emoji,
                    volume
                });
                if (answer.sound) onSaved(answer.sound);
                else setError(answer.error ?? t("errors.notDone"));
            }
        } catch {
            setError(t("errors.notDone"));
        } finally {
            setSaving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>
                        {isNew ? t("soundboardSettings.uploadTitle") : t("soundboardSettings.editTitle")}
                    </DialogTitle>
                    <DialogDescription>{t("soundboardSettings.uploadBody")}</DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    {isNew && (
                        <div className="flex min-w-0 flex-col gap-1.5">
                            <div className="flex min-w-0 items-center gap-2">
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    onClick={() => chooser.current?.click()}
                                    disabled={decoding}
                                >
                                    {decoding ? (
                                        <Loader2 className="size-3.5 animate-spin" />
                                    ) : (
                                        <Upload className="size-3.5" />
                                    )}
                                    {file ? t("soundboardSettings.otherFile") : t("soundboardSettings.chooseFile")}
                                </Button>
                                {file && (
                                    <span className="min-w-0 truncate text-xs text-muted-foreground" title={file.name}>
                                        {file.name}
                                    </span>
                                )}
                            </div>
                            <input
                                ref={chooser}
                                type="file"
                                accept={SOUND_ACCEPT}
                                className="sr-only"
                                tabIndex={-1}
                                aria-hidden
                                onChange={(event) => {
                                    void choose(event.target.files?.[0]);
                                    event.target.value = "";
                                }}
                            />
                            {decoded && (
                                <p className="text-xs text-muted-foreground">
                                    {longer
                                        ? t("soundboardSettings.tooLongCut", {
                                              seconds: seconds(decoded.durationMs),
                                              max: seconds(rules.SOUND_MAX_MS)
                                          })
                                        : t("soundboardSettings.length", { seconds: seconds(decoded.durationMs) })}
                                </p>
                            )}
                            {decoded && longer && (
                                <label className="flex flex-col gap-1 text-xs">
                                    <span className="flex items-center justify-between">
                                        {t("soundboardSettings.start")}
                                        <span className="tabular-nums text-muted-foreground">
                                            {t("soundboardSettings.window", {
                                                from: seconds(startMs),
                                                to: seconds(Math.min(decoded.durationMs, startMs + rules.SOUND_MAX_MS))
                                            })}
                                        </span>
                                    </span>
                                    <input
                                        type="range"
                                        min={0}
                                        max={Math.max(0, decoded.durationMs - rules.SOUND_MAX_MS)}
                                        step={100}
                                        value={startMs}
                                        onChange={(event) => setStartMs(Number(event.target.value))}
                                        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                                    />
                                </label>
                            )}
                            {decoded && (
                                <Button size="sm" variant="ghost" className="self-start" onClick={() => void listen()}>
                                    <Volume2 className="size-3.5" />
                                    {t("soundboardSettings.listen")}
                                </Button>
                            )}
                        </div>
                    )}

                    <label className="flex flex-col gap-1 text-sm">
                        <span>
                            {t("soundboardSettings.name")} <span className="text-danger">*</span>
                        </span>
                        <Input
                            value={name}
                            maxLength={rules.SOUND_NAME_MAX + 4}
                            aria-invalid={nameError !== null}
                            onChange={(event) => {
                                setName(event.target.value);
                                setNameTouched(true);
                            }}
                        />
                        {nameError && (
                            <span className="text-xs text-danger" role="alert">
                                {nameError}
                            </span>
                        )}
                    </label>

                    <div className="flex flex-col gap-1 text-sm">
                        <span>{t("soundboardSettings.emoji")}</span>
                        <div className="flex items-center gap-2">
                            <span aria-hidden className="flex size-9 items-center justify-center rounded-md border border-border text-lg">
                                {emoji || SOUND_GLYPH}
                            </span>
                            <EmojiPicker
                                disabled={false}
                                label={t("soundboardSettings.pickEmoji")}
                                onEmoji={(chosen) => setEmoji(rules.isOneEmoji(chosen) ? chosen : "")}
                            />
                            {emoji && (
                                <Button size="sm" variant="ghost" onClick={() => setEmoji("")}>
                                    {t("soundboardSettings.noEmoji")}
                                </Button>
                            )}
                        </div>
                    </div>

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="flex items-center justify-between">
                            {t("soundboardSettings.volume")}
                            <span className="tabular-nums text-muted-foreground">{Math.round(volume * 100)}%</span>
                        </span>
                        <input
                            type="range"
                            min={0}
                            max={100}
                            step={5}
                            value={Math.round(volume * 100)}
                            onChange={(event) => setVolume(Number(event.target.value) / 100)}
                            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                        />
                        <span className="text-xs text-muted-foreground">{t("soundboardSettings.volumeHint")}</span>
                    </label>

                    {error && (
                        <p className="text-sm text-danger" role="alert">
                            {error}
                        </p>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        {t("soundboardSettings.cancel")}
                    </Button>
                    <Button onClick={() => void save()} aria-disabled={!ready} disabled={!ready}>
                        {saving && <Loader2 className="size-3.5 animate-spin" />}
                        {t("soundboardSettings.save")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
