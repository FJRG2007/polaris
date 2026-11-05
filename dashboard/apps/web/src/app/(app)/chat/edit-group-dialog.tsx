"use client";

/**
 * Editing a group: its icon and its name, in one dialog with one Save.
 *
 * Nothing is sent until Save. The icon chosen here is only a preview until then,
 * so Cancel really is cancel, and Save stays off until the name or the icon
 * differs from what was loaded.
 */

import * as actions from "./actions";
import * as core from "@polaris/core";
import { runAction } from "@/lib/run-action";
import { chatAvatarUrl } from "@/lib/avatar-url";
import { useEffect, useRef, useState } from "react";
import type { TenorResult } from "@/lib/chat/tenor";
import { ChatAvatar } from "@/components/chat-avatar";
import type { AvatarPerson } from "@/components/avatar";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ArrowLeft, ImagePlus, Loader2, Pencil } from "lucide-react";
import { ChooseFilesDialog } from "@/components/file-picker/choose-files-dialog";
import { CROP_ACCEPTED, FACE_CROP, ImageCropDialog } from "@/components/image-cropper";
import {
    Button,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    isDirty
} from "@polaris/ui";

/** What Save will do to the icon. */
export type IconDraft =
    | { kind: "keep" }
    | { kind: "upload"; blob: Blob; url: string }
    | { kind: "gif"; gif: TenorResult }
    | { kind: "remove" };

/** The ETag the avatar route answers with when there is no picture. */
const BLANK_ETAG = '"blank"';

/** Whether anything differs from what the dialog opened with. */
export function groupEditDirty(loadedName: string, name: string, icon: IconDraft): boolean {
    return icon.kind !== "keep" || isDirty(loadedName, name);
}

/** The picture a draft previews: its own, none, or the stored one. */
function previewOf(icon: IconDraft, hasIcon: boolean): string | null | undefined {
    if (icon.kind === "upload") return icon.url;
    if (icon.kind === "gif") return icon.gif.preview;
    if (icon.kind === "remove" || !hasIcon) return null;
    return undefined;
}

export function EditGroupDialog({
    channel,
    open,
    onOpenChange,
    onSaved
}: {
    channel: { id: string; name: string; others?: readonly AvatarPerson[] };
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSaved: () => void;
}) {
    const t = useTranslations("chat");
    const [name, setName] = useState("");
    const [icon, setIcon] = useState<IconDraft>({ kind: "keep" });
    const [hasIcon, setHasIcon] = useState(false);
    const [changing, setChanging] = useState(false);
    const [error, setError] = useState("");
    const [saving, setSaving] = useState(false);
    const endpoint = chatAvatarUrl("channel", channel.id);

    useEffect(() => {
        if (!open) return;
        setName(channel.name);
        setIcon({ kind: "keep" });
        setError("");
        let live = true;
        // The route answers a picture-less group with a blank pixel, told apart
        // only by its ETag - which is what decides whether "Remove icon" shows.
        fetch(endpoint, { cache: "no-cache" })
            .then((response) => live && setHasIcon(response.headers.get("etag") !== BLANK_ETAG))
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [open, channel.name, endpoint]);

    // A preview's object URL is let go once it is no longer the one on screen.
    useEffect(() => {
        if (icon.kind !== "upload") return;
        return () => URL.revokeObjectURL(icon.url);
    }, [icon]);

    const dirty = groupEditDirty(channel.name, name, icon);

    async function save(): Promise<void> {
        if (saving || !dirty) return;
        setSaving(true);
        setError("");
        const failed = await apply();
        setSaving(false);
        // Left open on a refusal, with the reason on it: a dialog that closes and
        // leaves the group unchanged looks like it worked.
        if (failed) return setError(failed);
        onOpenChange(false);
        onSaved();
        // The icon is drawn from one URL in many places, none of which will ask
        // for it again on their own; the new bytes are already cached by now.
        if (icon.kind !== "keep") window.location.reload();
    }

    /** Sends what changed, name first. Returns the reason it stopped, if any. */
    async function apply(): Promise<string | null> {
        if (isDirty(channel.name, name)) {
            let reason = "";
            const result = await runAction(
                () => actions.renameGroupAction({ channelId: channel.id, name }),
                (message) => (reason = message)
            );
            if (!result) return reason || t("errors.notSaved");
            if (result.error) return result.error;
        }
        if (icon.kind === "keep") return null;
        try {
            if (icon.kind === "gif") {
                const result = await actions.setGroupGifAction({
                    channelId: channel.id,
                    address: icon.gif.full
                });
                if (result.error) return result.error;
            } else {
                const response = await fetch(
                    endpoint,
                    icon.kind === "remove"
                        ? { method: "DELETE" }
                        : {
                              method: "POST",
                              headers: { "Content-Type": icon.blob.type },
                              body: icon.blob
                          }
                );
                if (!response.ok) return (await response.text()) || t("errors.notSaved");
            }
            await fetch(endpoint, { cache: "reload" }).catch(() => undefined);
            return null;
        } catch {
            return t("errors.notSaved");
        }
    }

    const showsIcon =
        icon.kind === "upload" || icon.kind === "gif" || (icon.kind === "keep" && hasIcon);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t("editGroup.title")}</DialogTitle>
                </DialogHeader>
                <div className="flex flex-col items-center gap-2">
                    <div className="relative">
                        <ChatAvatar
                            kind="channel"
                            id={channel.id}
                            name={name || channel.name}
                            members={channel.others ?? []}
                            picture={previewOf(icon, hasIcon)}
                            size={88}
                        />
                        <button
                            type="button"
                            aria-label={t("editGroup.changeIcon")}
                            title={t("editGroup.changeIcon")}
                            disabled={saving}
                            onClick={() => setChanging(true)}
                            className="absolute right-0 top-0 grid size-7 place-items-center rounded-full border border-border bg-surface-raised text-foreground shadow-sm hover:bg-surface-hover"
                        >
                            <Pencil className="size-3.5 shrink-0" />
                        </button>
                    </div>
                    {showsIcon && (
                        <button
                            type="button"
                            disabled={saving}
                            onClick={() => setIcon(hasIcon ? { kind: "remove" } : { kind: "keep" })}
                            className="text-xs text-danger hover:underline"
                        >
                            {t("editGroup.removeIcon")}
                        </button>
                    )}
                </div>
                <label className="flex flex-col gap-1.5 text-sm font-medium">
                    {t("editGroup.name")}
                    <Input
                        value={name}
                        maxLength={core.MAX_CHAT_CHANNEL_NAME}
                        placeholder={t("channelHeader.leaveItEmptyToGo")}
                        onChange={(event) => setName(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") void save();
                        }}
                    />
                </label>
                {error && (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                )}
                <DialogFooter>
                    <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                        {t("channelHeader.cancel")}
                    </Button>
                    <Button size="sm" disabled={saving || !dirty} onClick={() => void save()}>
                        {saving && <Loader2 className="size-4 animate-spin" />}
                        {t("channelHeader.save")}
                    </Button>
                </DialogFooter>
            </DialogContent>
            {changing ? (
                <ChangeIconDialog
                    onClose={() => setChanging(false)}
                    onPicked={(next) => {
                        setChanging(false);
                        setIcon(next);
                    }}
                />
            ) : null}
        </Dialog>
    );
}

/** The two ways to a new icon: a file of your own, or a GIF from the picker. */
function ChangeIconDialog({
    onClose,
    onPicked
}: {
    onClose: () => void;
    onPicked: (icon: IconDraft) => void;
}) {
    const t = useTranslations("chat");
    const [step, setStep] = useState<"tiles" | "gif">("tiles");
    const [picking, setPicking] = useState(false);
    const [chosen, setChosen] = useState<File | null>(null);
    const [gifsReady, setGifsReady] = useState<boolean | null>(null);
    const [trending, setTrending] = useState<TenorResult[]>([]);
    const [error, setError] = useState("");

    useEffect(() => {
        let live = true;
        void actions
            .tenorReadyAction()
            .then(async (ready) => {
                if (!live) return;
                setGifsReady(ready);
                if (!ready) return;
                const { results } = await actions.searchTenorAction("", "gif");
                if (live) setTrending(results);
            })
            .catch(() => live && setGifsReady(false));
        return () => {
            live = false;
        };
    }, []);

    return (
        <Dialog open onOpenChange={(next) => !next && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        {step === "gif" && (
                            <button
                                type="button"
                                aria-label={t("editGroup.back")}
                                title={t("editGroup.back")}
                                onClick={() => setStep("tiles")}
                                className="grid size-7 place-items-center rounded-md hover:bg-surface-hover"
                            >
                                <ArrowLeft className="size-4 shrink-0" />
                            </button>
                        )}
                        {step === "gif" ? t("editGroup.chooseGif") : t("editGroup.changeIcon")}
                    </DialogTitle>
                </DialogHeader>
                {step === "tiles" ? (
                    <div className="grid grid-cols-2 gap-3">
                        <button
                            type="button"
                            onClick={() => setPicking(true)}
                            className="flex aspect-square min-w-0 flex-col items-center justify-center gap-2 rounded-lg border border-border bg-surface-sunken p-3 text-sm font-medium hover:bg-surface-hover"
                        >
                            <ImagePlus className="size-8 shrink-0 text-muted-foreground" />
                            <span className="truncate">{t("editGroup.uploadImage")}</span>
                        </button>
                        <button
                            type="button"
                            disabled={gifsReady !== true}
                            title={gifsReady === false ? t("editGroup.gifsOff") : undefined}
                            onClick={() => setStep("gif")}
                            className="flex aspect-square min-w-0 flex-col items-center justify-center gap-2 rounded-lg border border-border bg-surface-sunken p-3 text-sm font-medium hover:bg-surface-hover disabled:opacity-50"
                        >
                            <span className="grid size-20 grid-cols-2 gap-0.5 overflow-hidden rounded-md bg-surface-hover">
                                {trending.slice(0, 4).map((gif) => (
                                    // eslint-disable-next-line @next/next/no-img-element -- a picker thumbnail
                                    <img
                                        key={gif.id}
                                        src={gif.preview}
                                        alt=""
                                        className="size-full object-cover"
                                    />
                                ))}
                            </span>
                            <span className="truncate">{t("editGroup.chooseGif")}</span>
                            {gifsReady === false && (
                                <span className="text-xs font-normal text-muted-foreground">
                                    {t("editGroup.gifsOff")}
                                </span>
                            )}
                        </button>
                    </div>
                ) : (
                    <GifGrid
                        trending={trending}
                        onChosen={(gif) => onPicked({ kind: "gif", gif })}
                    />
                )}
                {error && (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                )}
            </DialogContent>
            {picking ? (
                <ChooseFilesDialog
                    accept={CROP_ACCEPTED}
                    onClose={() => setPicking(false)}
                    onFailed={setError}
                    onFiles={(files) => setChosen(files[0] ?? null)}
                />
            ) : null}
            {chosen ? (
                <ImageCropDialog
                    file={chosen}
                    shape={FACE_CROP}
                    busy={false}
                    onCancel={() => setChosen(null)}
                    onCropped={(blob) => {
                        setChosen(null);
                        onPicked({ kind: "upload", blob, url: URL.createObjectURL(blob) });
                    }}
                />
            ) : null}
        </Dialog>
    );
}

/** Search the connected GIF service, trending until something is typed. */
function GifGrid({
    trending,
    onChosen
}: {
    trending: TenorResult[];
    onChosen: (gif: TenorResult) => void;
}) {
    const t = useTranslations("chat");
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<TenorResult[] | null>(null);
    const asked = useRef(0);

    useEffect(() => {
        const term = query.trim();
        if (!term) return setResults(null);
        const ticket = ++asked.current;
        const timer = window.setTimeout(() => {
            void actions
                .searchTenorAction(term, "gif")
                .then(({ results: found }) => ticket === asked.current && setResults(found))
                .catch(() => ticket === asked.current && setResults([]));
        }, 300);
        return () => window.clearTimeout(timer);
    }, [query]);

    const shown = results ?? trending;
    return (
        <div className="flex min-w-0 flex-col gap-3">
            <Input
                value={query}
                autoFocus
                placeholder={t("editGroup.searchGifs")}
                aria-label={t("editGroup.searchGifs")}
                onChange={(event) => setQuery(event.target.value)}
            />
            <div className="grid max-h-80 grid-cols-3 gap-1.5 overflow-y-auto">
                {shown.map((gif) => (
                    <button
                        key={gif.id}
                        type="button"
                        title={gif.description}
                        onClick={() => onChosen(gif)}
                        className="aspect-square overflow-hidden rounded-md bg-surface-sunken hover:ring-2 hover:ring-accent"
                    >
                        {/* eslint-disable-next-line @next/next/no-img-element -- a picker thumbnail */}
                        <img
                            src={gif.preview}
                            alt={gif.description}
                            className="size-full object-cover"
                        />
                    </button>
                ))}
            </div>
            {shown.length === 0 && (
                <p className="text-center text-sm text-muted-foreground">{t("editGroup.noGifs")}</p>
            )}
        </div>
    );
}
