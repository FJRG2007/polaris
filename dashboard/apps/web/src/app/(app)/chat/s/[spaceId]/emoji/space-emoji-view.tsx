"use client";

/**
 * A space's own emoji: the two lists, adding, renaming and removing.
 *
 * Laid out the way Discord's Emoji page is, because that is where everybody who
 * has run a server learned it: ordinary and animated in two lists, each with how
 * many of its fifty are used, the name editable where it is shown, and who added
 * each one.
 *
 * Several files may be chosen (or dropped) at once. Each is checked here before
 * it is sent - its kind, its size, its name - and sent on its own, so one that
 * is refused says why beside its own picture and the rest still go in. A file
 * the server turns down stays in the tray with the reason, its name editable,
 * to be tried again or dismissed.
 *
 * Everybody in the space can open the page and see what there is; only its
 * owner and administrators can change it, and everybody else is told so rather
 * than shown controls that would be refused.
 */

import Link from "next/link";
import * as core from "@polaris/core";
import { Avatar } from "@/components/avatar";
import { useChat } from "@/app/(app)/chat/chat-context";
import { MessageTime } from "@/components/message-time";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { EmojiPicture } from "@/components/rich-text/custom-emoji";
import type { SpaceEmojiView as SpaceEmoji } from "@/lib/chat/custom-emoji";
import { emojiSrc, patchSpaceEmoji, useSpaceEmoji } from "@/app/(app)/chat/space-emoji";
import { ArrowLeft, Loader2, RotateCcw, Smile, Trash2, Upload, X } from "lucide-react";
import { Button, cn, ConfirmDeleteDialog, EmptyState, Input, Skeleton } from "@polaris/ui";
import {
    deleteSpaceEmojiAction,
    renameSpaceEmojiAction,
    uploadSpaceEmojiAction
} from "@/app/(app)/chat/emoji-actions";

/** One file chosen for upload and not in the list yet. */
interface Staged {
    readonly key: string;
    readonly file: File;
    readonly preview: string;
    readonly name: string;
    /** Why it was refused, by this page or by the server. */
    readonly error: string | null;
    readonly sending: boolean;
}

const KINDS = new Set<string>(core.CUSTOM_EMOJI_TYPES);

/** The name refusal the shared rules give, as the word the catalog keys on. */
function nameProblem(name: string): core.CustomEmojiNameProblem | null {
    const parsed = core.customEmojiNameSchema.safeParse(name);
    if (parsed.success) return null;
    return (
        (parsed.error.issues[0]?.message as core.CustomEmojiNameProblem | undefined) ?? "characters"
    );
}

export function SpaceEmojiView({ spaceId }: { spaceId: string }) {
    const t = useTranslations("chat");
    const { spaces } = useChat();
    const space = spaces.find((entry) => entry.id === spaceId) ?? null;
    const { list, failed, refresh } = useSpaceEmoji(spaceId);
    const manages = list?.manages ?? false;
    const emoji = list?.emoji ?? null;

    const [staged, setStaged] = useState<readonly Staged[]>([]);
    const [deleting, setDeleting] = useState<SpaceEmoji | null>(null);
    const [deleteError, setDeleteError] = useState<string | null>(null);
    const [deletePending, setDeletePending] = useState(false);
    const [dragging, setDragging] = useState(false);
    const chooser = useRef<HTMLInputElement>(null);

    // The previews are object URLs, which outlive the page unless let go.
    const previews = useRef(new Set<string>());
    useEffect(() => {
        const held = previews.current;
        return () => {
            for (const url of held) URL.revokeObjectURL(url);
        };
    }, []);

    const refusalFor = useCallback(
        (problem: core.CustomEmojiNameProblem): string => {
            if (problem === "short") return t("errors.emojiNameShort");
            if (problem === "long") return t("errors.emojiNameLong");
            if (problem === "edges") return t("errors.emojiNameEdges");
            return t("errors.emojiNameCharacters");
        },
        [t]
    );

    /** Whether another emoji of the space, or another file in the tray, has
     *  this name - the same comparison the server makes, ignoring case. */
    const taken = useCallback(
        (name: string, except: string): boolean => {
            const key = core.customEmojiNameKey(core.normalizeEmojiName(name));
            return (
                (emoji ?? []).some((one) => one.id !== except && one.name.toLowerCase() === key) ||
                staged.some(
                    (one) =>
                        one.key !== except &&
                        core.customEmojiNameKey(core.normalizeEmojiName(one.name)) === key
                )
            );
        },
        [emoji, staged]
    );

    /** Why a name cannot be used, or null. */
    const nameRefusal = useCallback(
        (name: string, except: string): string | null => {
            const problem = nameProblem(name);
            if (problem) return refusalFor(problem);
            return taken(name, except) ? t("errors.emojiNameTaken") : null;
        },
        [refusalFor, taken, t]
    );

    const fileRefusal = useCallback(
        (file: File): string | null => {
            if (file.size === 0) return t("errors.emojiFileEmpty");
            if (!KINDS.has(file.type)) return t("errors.emojiFileType");
            if (file.size > core.CUSTOM_EMOJI_MAX_BYTES) return t("errors.emojiFileSize");
            return null;
        },
        [t]
    );

    const update = (key: string, change: Partial<Staged>) =>
        setStaged((current) =>
            current.map((one) => (one.key === key ? { ...one, ...change } : one))
        );

    const dismiss = (key: string) =>
        setStaged((current) => {
            const gone = current.find((one) => one.key === key);
            if (gone) {
                URL.revokeObjectURL(gone.preview);
                previews.current.delete(gone.preview);
            }
            return current.filter((one) => one.key !== key);
        });

    /** Send one file. Kept in the tray with the reason when it is refused. */
    const send = async (item: Staged): Promise<void> => {
        update(item.key, { sending: true, error: null });
        const form = new FormData();
        form.set("spaceId", spaceId);
        form.set("name", core.normalizeEmojiName(item.name));
        form.set("file", item.file);
        try {
            const result = await uploadSpaceEmojiAction(form);
            if (result.emoji) {
                const added = result.emoji;
                patchSpaceEmoji(spaceId, (current) => [
                    ...current.filter((one) => one.id !== added.id),
                    added
                ]);
                dismiss(item.key);
                return;
            }
            update(item.key, {
                sending: false,
                error: result.error ?? t("spaceEmoji.uploadFailed")
            });
        } catch {
            update(item.key, { sending: false, error: t("spaceEmoji.uploadFailed") });
        }
    };

    /** Put files in the tray and send every one that passes the checks here,
     *  one after another. */
    const stage = (files: FileList | null) => {
        if (!files || files.length === 0) return;
        const names = new Set<string>([
            ...(emoji ?? []).map((one) => one.name.toLowerCase()),
            ...staged.map((one) => core.customEmojiNameKey(core.normalizeEmojiName(one.name)))
        ]);
        const items = [...files].map((file): Staged => {
            const preview = URL.createObjectURL(file);
            previews.current.add(preview);
            const name = core.emojiNameFromFile(file.name);
            const key = core.customEmojiNameKey(name);
            const problem = nameProblem(name);
            const error =
                fileRefusal(file) ??
                (problem
                    ? refusalFor(problem)
                    : names.has(key)
                      ? t("errors.emojiNameTaken")
                      : null);
            names.add(key);
            return { key: crypto.randomUUID(), file, preview, name, error, sending: false };
        });
        setStaged((current) => [...current, ...items]);
        void (async () => {
            for (const item of items) if (item.error === null) await send(item);
        })();
    };

    const rename = async (target: SpaceEmoji, name: string): Promise<string | null> => {
        const before = target.name;
        const next = core.normalizeEmojiName(name);
        patchSpaceEmoji(spaceId, (current) =>
            current.map((one) => (one.id === target.id ? { ...one, name: next } : one))
        );
        try {
            const result = await renameSpaceEmojiAction({ emojiId: target.id, name: next });
            if (result.emoji) return null;
            patchSpaceEmoji(spaceId, (current) =>
                current.map((one) => (one.id === target.id ? { ...one, name: before } : one))
            );
            return result.error ?? t("spaceEmoji.renameFailed");
        } catch {
            patchSpaceEmoji(spaceId, (current) =>
                current.map((one) => (one.id === target.id ? { ...one, name: before } : one))
            );
            return t("spaceEmoji.renameFailed");
        }
    };

    const remove = async () => {
        if (!deleting) return;
        const target = deleting;
        setDeletePending(true);
        setDeleteError(null);
        try {
            const result = await deleteSpaceEmojiAction({ emojiId: target.id });
            if (result.error) {
                setDeleteError(result.error);
                return;
            }
            patchSpaceEmoji(spaceId, (current) => current.filter((one) => one.id !== target.id));
            setDeleting(null);
        } catch {
            setDeleteError(t("spaceEmoji.deleteFailed"));
        } finally {
            setDeletePending(false);
        }
    };

    const ordinary = emoji?.filter((one) => !one.animated) ?? null;
    const animated = emoji?.filter((one) => one.animated) ?? null;
    const full =
        ordinary !== null &&
        animated !== null &&
        ordinary.length >= core.CUSTOM_EMOJI_SLOTS &&
        animated.length >= core.CUSTOM_EMOJI_SLOTS;
    const spaceName = space?.name ?? "";

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex h-header shrink-0 items-center gap-2 border-b border-border px-3">
                <Link
                    href="/chat"
                    aria-label={t("spaceEmoji.back")}
                    className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:hidden"
                >
                    <ArrowLeft className="size-4" />
                </Link>
                <Smile className="size-4 shrink-0 text-primary" />
                <span className="shrink-0 text-sm font-semibold">{t("spaceEmoji.title")}</span>
                {spaceName && (
                    <span
                        className="min-w-0 truncate text-sm text-muted-foreground"
                        title={spaceName}
                    >
                        {spaceName}
                    </span>
                )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4">
                    <section className="flex flex-col gap-3">
                        <p className="text-sm text-muted-foreground">
                            {spaceName
                                ? t("spaceEmoji.intro", { space: spaceName })
                                : t("spaceEmoji.introNoName")}
                        </p>
                        {list === null && failed === null ? (
                            <Skeleton className="h-24 w-full" />
                        ) : manages ? (
                            <div
                                onDragOver={(event) => {
                                    event.preventDefault();
                                    setDragging(true);
                                }}
                                onDragLeave={() => setDragging(false)}
                                onDrop={(event) => {
                                    event.preventDefault();
                                    setDragging(false);
                                    if (!full) stage(event.dataTransfer.files);
                                }}
                                className={cn(
                                    "flex flex-col gap-3 rounded-lg border border-dashed p-4 transition-colors sm:flex-row sm:items-center",
                                    dragging
                                        ? "border-primary bg-primary/5"
                                        : "border-border bg-card"
                                )}
                            >
                                <div className="min-w-0 flex-1 text-xs text-muted-foreground">
                                    <p className="font-medium text-foreground">
                                        {t("spaceEmoji.rulesTitle")}
                                    </p>
                                    <ul className="mt-1 list-disc pl-4">
                                        <li>{t("spaceEmoji.ruleFiles")}</li>
                                        <li>{t("spaceEmoji.ruleNames")}</li>
                                        <li>
                                            {t("spaceEmoji.ruleSlots", {
                                                total: core.CUSTOM_EMOJI_SLOTS
                                            })}
                                        </li>
                                    </ul>
                                </div>
                                <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
                                    <Button
                                        type="button"
                                        size="sm"
                                        disabled={full}
                                        onClick={() => chooser.current?.click()}
                                    >
                                        <Upload className="size-3.5" />
                                        {t("spaceEmoji.upload")}
                                    </Button>
                                    {full && (
                                        <p className="text-xs text-muted-foreground">
                                            {t("spaceEmoji.full")}
                                        </p>
                                    )}
                                    <input
                                        ref={chooser}
                                        type="file"
                                        multiple
                                        accept={core.CUSTOM_EMOJI_ACCEPT}
                                        className="sr-only"
                                        tabIndex={-1}
                                        aria-hidden
                                        onChange={(event) => {
                                            stage(event.target.files);
                                            event.target.value = "";
                                        }}
                                    />
                                </div>
                            </div>
                        ) : list !== null ? (
                            <p className="rounded-lg border border-border bg-card p-3 text-xs text-muted-foreground">
                                {t("spaceEmoji.readOnly")}
                            </p>
                        ) : null}

                        {staged.length > 0 && (
                            <ul className="flex flex-col gap-2" aria-label={t("spaceEmoji.tray")}>
                                {staged.map((item) => {
                                    const nameError = item.error === null ? null : item.error;
                                    const live = nameRefusal(item.name, item.key);
                                    const fileError = fileRefusal(item.file);
                                    return (
                                        <li
                                            key={item.key}
                                            className="flex items-start gap-3 rounded-lg border border-border bg-card p-3"
                                        >
                                            <img
                                                src={item.preview}
                                                alt=""
                                                className="size-8 shrink-0 rounded object-contain"
                                            />
                                            <div className="flex min-w-0 flex-1 flex-col gap-1">
                                                <p
                                                    className="truncate text-xs text-muted-foreground"
                                                    title={item.file.name}
                                                >
                                                    {item.file.name}
                                                </p>
                                                <Input
                                                    value={item.name}
                                                    disabled={item.sending || fileError !== null}
                                                    aria-label={t("spaceEmoji.name")}
                                                    aria-invalid={live !== null}
                                                    maxLength={core.CUSTOM_EMOJI_NAME_MAX + 2}
                                                    onChange={(event) =>
                                                        update(item.key, {
                                                            name: event.target.value,
                                                            error: null
                                                        })
                                                    }
                                                    className="h-8"
                                                />
                                                {(fileError ?? live ?? nameError) &&
                                                    !item.sending && (
                                                        <p
                                                            className="text-xs text-danger"
                                                            role="alert"
                                                        >
                                                            {fileError ?? live ?? nameError}
                                                        </p>
                                                    )}
                                            </div>
                                            <div className="flex shrink-0 items-center gap-1 pt-5">
                                                {item.sending ? (
                                                    <Loader2
                                                        className="size-4 animate-spin text-muted-foreground"
                                                        aria-label={t("spaceEmoji.uploading")}
                                                    />
                                                ) : (
                                                    <>
                                                        {fileError === null && (
                                                            <button
                                                                type="button"
                                                                disabled={live !== null}
                                                                onClick={() => void send(item)}
                                                                aria-label={t(
                                                                    "spaceEmoji.tryAgain"
                                                                )}
                                                                title={t("spaceEmoji.tryAgain")}
                                                                className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                                                            >
                                                                <RotateCcw className="size-3.5" />
                                                            </button>
                                                        )}
                                                        <button
                                                            type="button"
                                                            onClick={() => dismiss(item.key)}
                                                            aria-label={t("spaceEmoji.dismiss")}
                                                            title={t("spaceEmoji.dismiss")}
                                                            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                                        >
                                                            <X className="size-3.5" />
                                                        </button>
                                                    </>
                                                )}
                                            </div>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </section>

                    {failed !== null && list === null ? (
                        <div className="flex flex-col items-start gap-2 rounded-lg border border-border bg-card p-4">
                            <p className="text-sm text-danger" role="alert">
                                {failed || t("spaceEmoji.loadFailed")}
                            </p>
                            <Button type="button" size="sm" variant="outline" onClick={refresh}>
                                <RotateCcw className="size-3.5" />
                                {t("spaceEmoji.retry")}
                            </Button>
                        </div>
                    ) : (
                        <>
                            <EmojiSection
                                title={t("spaceEmoji.ordinary")}
                                empty={t("spaceEmoji.noOrdinary")}
                                items={ordinary}
                                manages={manages}
                                nameRefusal={nameRefusal}
                                onRename={rename}
                                onDelete={(target) => {
                                    setDeleteError(null);
                                    setDeleting(target);
                                }}
                            />
                            <EmojiSection
                                title={t("spaceEmoji.animated")}
                                empty={t("spaceEmoji.noAnimated")}
                                items={animated}
                                manages={manages}
                                nameRefusal={nameRefusal}
                                onRename={rename}
                                onDelete={(target) => {
                                    setDeleteError(null);
                                    setDeleting(target);
                                }}
                            />
                        </>
                    )}
                </div>
            </div>

            <ConfirmDeleteDialog
                open={deleting !== null}
                onOpenChange={(open) => !open && setDeleting(null)}
                requireTyping={false}
                name={deleting ? core.customEmojiFallback(deleting) : ""}
                kind=""
                title={t("spaceEmoji.deleteTitle")}
                question={t("spaceEmoji.deleteQuestion", {
                    name: deleting ? core.customEmojiFallback(deleting) : ""
                })}
                description={t("spaceEmoji.deleteBody")}
                confirmLabel={t("spaceEmoji.delete")}
                error={deleteError}
                pending={deletePending}
                onConfirm={() => void remove()}
                strings={{ cancel: t("spaceEmoji.cancel") }}
            />
        </div>
    );
}

/** One of the two lists, with how many of its slots are used. */
function EmojiSection({
    title,
    empty,
    items,
    manages,
    nameRefusal,
    onRename,
    onDelete
}: {
    title: string;
    empty: string;
    /** Null while the list is on its way. */
    items: readonly SpaceEmoji[] | null;
    manages: boolean;
    nameRefusal: (name: string, except: string) => string | null;
    onRename: (target: SpaceEmoji, name: string) => Promise<string | null>;
    onDelete: (target: SpaceEmoji) => void;
}) {
    const t = useTranslations("chat");
    return (
        <section className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-2">
                <h2 className="min-w-0 truncate text-sm font-semibold" title={title}>
                    {title}
                </h2>
                {items !== null && (
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {t("spaceEmoji.slots", {
                            count: items.length,
                            total: core.CUSTOM_EMOJI_SLOTS
                        })}
                    </span>
                )}
            </div>
            {items === null ? (
                <div className="flex flex-col gap-2" aria-hidden="true">
                    {[0, 1, 2].map((row) => (
                        <Skeleton key={row} className="h-14 w-full" />
                    ))}
                </div>
            ) : items.length === 0 ? (
                <EmptyState icon={<Smile />} title={empty} />
            ) : (
                <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
                    {items.map((item) => (
                        <EmojiRow
                            key={item.id}
                            item={item}
                            manages={manages}
                            nameRefusal={nameRefusal}
                            onRename={onRename}
                            onDelete={onDelete}
                        />
                    ))}
                </ul>
            )}
        </section>
    );
}

/** One emoji: its picture, its name (editable where the reader may), who added
 *  it and when. */
function EmojiRow({
    item,
    manages,
    nameRefusal,
    onRename,
    onDelete
}: {
    item: SpaceEmoji;
    manages: boolean;
    nameRefusal: (name: string, except: string) => string | null;
    onRename: (target: SpaceEmoji, name: string) => Promise<string | null>;
    onDelete: (target: SpaceEmoji) => void;
}) {
    const t = useTranslations("chat");
    const [draft, setDraft] = useState(item.name);
    const [refused, setRefused] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const editing = draft !== item.name;
    const live = editing ? nameRefusal(draft, item.id) : null;

    // A rename from another tab, or the rollback of a refused one.
    useEffect(() => setDraft(item.name), [item.name]);

    const commit = async () => {
        const next = core.normalizeEmojiName(draft);
        if (next === item.name) {
            setDraft(item.name);
            return;
        }
        if (live) return;
        setSaving(true);
        const error = await onRename(item, next);
        setSaving(false);
        setRefused(error);
        if (error) setDraft(item.name);
    };

    const entry = { id: item.id, name: item.name, animated: item.animated, src: emojiSrc(item.id) };
    const uploader = item.uploaderName ?? t("spaceEmoji.formerMember");

    return (
        <li className="flex items-start gap-3 p-3">
            <EmojiPicture entry={entry} className="mt-0.5 size-8 shrink-0" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
                {manages ? (
                    <Input
                        value={draft}
                        disabled={saving}
                        aria-label={t("spaceEmoji.renameLabel", { name: item.name })}
                        aria-invalid={live !== null}
                        maxLength={core.CUSTOM_EMOJI_NAME_MAX + 2}
                        onChange={(event) => {
                            setDraft(event.target.value);
                            setRefused(null);
                        }}
                        onBlur={() => void commit()}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") {
                                event.preventDefault();
                                void commit();
                            }
                            if (event.key === "Escape") {
                                setDraft(item.name);
                                setRefused(null);
                            }
                        }}
                        className="h-8"
                    />
                ) : (
                    <p
                        className="truncate text-sm font-medium"
                        title={core.customEmojiFallback(item)}
                    >
                        {core.customEmojiFallback(item)}
                    </p>
                )}
                {(live ?? refused) && (
                    <p className="text-xs text-danger" role="alert">
                        {live ?? refused}
                    </p>
                )}
                <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                    {item.uploaderId && (
                        <Avatar person={{ id: item.uploaderId, name: uploader }} size={16} />
                    )}
                    <span className="min-w-0 truncate" title={uploader}>
                        {t("spaceEmoji.addedBy", { name: uploader })}
                    </span>
                    <MessageTime iso={item.createdAt} className="shrink-0 whitespace-nowrap" />
                </p>
            </div>
            {manages && (
                <button
                    type="button"
                    onClick={() => onDelete(item)}
                    aria-label={t("spaceEmoji.deleteLabel", { name: item.name })}
                    title={t("spaceEmoji.delete")}
                    className="shrink-0 rounded p-1.5 text-muted-foreground transition-colors hover:bg-danger-soft hover:text-danger"
                >
                    <Trash2 className="size-3.5" />
                </button>
            )}
        </li>
    );
}
