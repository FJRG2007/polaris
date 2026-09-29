"use client";

/**
 * The people the house knows by sight.
 *
 * The screen says plainly where the faces live, because it matters and because
 * nobody would guess: Polaris keeps a name, and the photographs stay in the
 * recognizer on the machine it was installed on. Somebody removed here is
 * removed there too.
 *
 * A few photographs beat one. The count is read back from the recognizer rather
 * than kept here, so what this screen says is what it actually holds.
 */

import Link from "next/link";
import * as actions from "../actions";
import { PersonDialog } from "./person-dialog";
import { useEffect, useRef, useState } from "react";
import type { PersonView } from "../../lib/people";
import { focusAfterMove } from "../../lib/list-selection";
import { FACE_IMAGE_TYPES } from "../../lib/face-image";
import { ImagePlus, Loader2, Pencil, ScanFace, Trash2, UserPlus } from "lucide-react";
import {
    cn,
    Badge,
    Input,
    Button,
    Switch,
    Skeleton,
    EmptyState,
    ContextMenu,
    ContextMenuItem,
    ContextMenuLabel,
    useDeferredFocus,
    ContextMenuContent,
    ContextMenuTrigger,
    ContextMenuSeparator,
    ConfirmDeleteDialog
} from "@polaris/ui";
import { hostUi } from "@polaris/app-host/client";
import { usePlacesT } from "../use-places-t";

const { runAction } = hostUi.runAction;

export function PeopleView({ canManage }: { canManage: boolean }) {
    const t = usePlacesT();
    const [people, setPeople] = useState<PersonView[] | null>(null);
    const [ready, setReady] = useState(true);
    const [adding, setAdding] = useState(false);
    const [uploading, setUploading] = useState<string | null>(null);
    const [removing, setRemoving] = useState<PersonView | null>(null);
    const [error, setError] = useState<string | null>(null);
    const fileInput = useRef<HTMLInputElement | null>(null);
    const uploadFor = useRef<string | null>(null);
    // The row the keyboard is on, and the one being renamed in place.
    const [focused, setFocused] = useState<string | null>(null);
    const [renaming, setRenaming] = useState<string | null>(null);
    const [draft, setDraft] = useState("");
    // Renaming is reached from the right-click menu, which is still holding the
    // keyboard when the field appears; it takes focus once the menu has gone.
    const nameField = useDeferredFocus<HTMLInputElement>(renaming !== null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const result = await actions.listPeopleAction();
            if (cancelled) return;
            if (result.error) setError(result.error);
            setPeople(result.people ?? []);
            setReady(result.recognizerReady ?? false);
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const added = (person: PersonView) => {
        setAdding(false);
        setPeople((current) =>
            [...(current ?? []), person].sort((a, b) => a.name.localeCompare(b.name))
        );
    };

    const pickPhoto = (person: PersonView) => {
        uploadFor.current = person.id;
        fileInput.current?.click();
    };

    const upload = async (file: File) => {
        const id = uploadFor.current;
        if (!id) return;
        setUploading(id);
        setError(null);
        const bytes = new Uint8Array(await file.arrayBuffer());
        const result = await runAction(() => actions.addFaceAction(id, bytes, file.type), setError);
        setUploading(null);
        if (result?.error) {
            setError(result.error);
            return;
        }
        setPeople((current) =>
            (current ?? []).map((person) =>
                person.id === id ? { ...person, faces: person.faces + 1 } : person
            )
        );
    };

    const remove = async (person: PersonView) => {
        const result = await runAction(() => actions.removePersonAction(person.id), setError);
        setRemoving(null);
        if (result?.error) {
            setError(result.error);
            return;
        }
        setPeople((current) => (current ?? []).filter((item) => item.id !== person.id));
    };

    const startRename = (person: PersonView) => {
        setFocused(person.id);
        setDraft(person.name);
        setRenaming(person.id);
    };

    /** Save what was typed, unless it is the name they already had - a field
     *  opened and closed is not a change to send anywhere. */
    const commitRename = async (person: PersonView) => {
        const wanted = draft.trim();
        setRenaming(null);
        if (!wanted || wanted === person.name) return;
        setPeople((current) =>
            (current ?? []).map((item) =>
                item.id === person.id ? { ...item, name: wanted } : item
            )
        );
        const result = await runAction(
            () => actions.renamePersonAction(person.id, wanted),
            setError
        );
        if (result?.error) {
            setError(result.error);
            setPeople((current) =>
                (current ?? []).map((item) =>
                    item.id === person.id ? { ...item, name: person.name } : item
                )
            );
        }
    };

    /** F2 renames, Delete forgets, the arrows walk the list. The same keys the
     *  clips list and Drive answer to. */
    const onKeyDown = (event: React.KeyboardEvent) => {
        if (renaming) return;
        const list = people ?? [];
        const index = list.findIndex((person) => person.id === focused);
        const current = list[index];
        if (event.key === "F2" && current && canManage) {
            event.preventDefault();
            startRename(current);
        } else if (event.key === "Delete" && current && canManage) {
            event.preventDefault();
            setRemoving(current);
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const landed = focusAfterMove(
                list.map((item) => item.id),
                focused,
                event.key === "ArrowDown" ? 1 : -1
            );
            if (landed) setFocused(landed);
        }
    };

    // The button to add somebody is drawn at once; only the list waits for the
    // read. The banner below starts hidden (`ready` is true until the read says
    // otherwise), so nothing appears only to be taken back.
    return (
        <div className="flex flex-col gap-4">
            {!ready ? (
                <p className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-[0.75rem] text-muted-foreground">
                    {t("people.noRecognizer")}
                    <Button asChild variant="secondary" size="sm">
                        <Link href="/places/settings">{t("people.setUp")}</Link>
                    </Button>
                </p>
            ) : null}

            {canManage ? (
                <div className="flex flex-wrap gap-2">
                    <Button onClick={() => setAdding(true)}>
                        <UserPlus className="size-4 shrink-0" />
                        {t("people.add")}
                    </Button>
                </div>
            ) : null}

            {error ? <p className="text-[0.75rem] text-danger">{error}</p> : null}

            {people === null ? (
                <Skeleton className="h-48 w-full" />
            ) : people.length === 0 ? (
                <EmptyState
                    icon={<ScanFace />}
                    title={t("people.emptyTitle")}
                    description={t("people.emptyBody")}
                    action={
                        canManage ? (
                            <Button size="sm" onClick={() => setAdding(true)}>
                                <UserPlus className="size-4 shrink-0" />
                                {t("people.add")}
                            </Button>
                        ) : undefined
                    }
                />
            ) : (
                <ul
                    tabIndex={0}
                    onKeyDown={onKeyDown}
                    aria-label={t("pages.people.title")}
                    className="flex flex-col divide-y divide-border rounded-lg border border-border"
                >
                    {people.map((person) => (
                        <ContextMenu key={person.id}>
                            <ContextMenuTrigger asChild>
                                <li
                                    onClick={() => setFocused(person.id)}
                                    onContextMenu={() => setFocused(person.id)}
                                    onDoubleClick={() => canManage && startRename(person)}
                                    className={cn(
                                        "flex items-center justify-between gap-3 px-3 py-2",
                                        focused === person.id && "bg-primary/10"
                                    )}
                                >
                                    <div className="min-w-0">
                                        {renaming === person.id ? (
                                            <Input
                                                ref={nameField}
                                                value={draft}
                                                aria-label={t("people.nameFor", { name: person.name })}
                                                className="h-7 text-[0.8125rem]"
                                                onChange={(event) => setDraft(event.target.value)}
                                                onBlur={() => commitRename(person)}
                                                onKeyDown={(event) => {
                                                    if (event.key === "Enter") {
                                                        event.preventDefault();
                                                        void commitRename(person);
                                                    } else if (event.key === "Escape") {
                                                        event.preventDefault();
                                                        setRenaming(null);
                                                    }
                                                }}
                                            />
                                        ) : (
                                            <p
                                                className="truncate text-[0.8125rem] text-foreground"
                                                title={person.name}
                                            >
                                                {person.name}
                                            </p>
                                        )}
                                        <p className="truncate text-[0.6875rem] text-foreground-subtle">
                                            {person.faces === 0
                                                ? t("people.noPhotos")
                                                : t("people.photoCount", { count: person.faces })}
                                        </p>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-2">
                                        {person.faces > 0 && person.faces < 3 ? (
                                            <Badge
                                                variant="warning"
                                                title={t("people.fewHint")}
                                            >
                                                {t("people.addMore")}
                                            </Badge>
                                        ) : null}
                                        <label className="flex items-center gap-1.5 text-[0.75rem] text-muted-foreground">
                                            {t("people.tellMe")}
                                            <Switch
                                                checked={person.notify}
                                                aria-label={t("people.reportWhen", { name: person.name })}
                                                onChange={(value) => {
                                                    setPeople((current) =>
                                                        (current ?? []).map((item) =>
                                                            item.id === person.id
                                                                ? { ...item, notify: value }
                                                                : item
                                                        )
                                                    );
                                                    void actions.setPersonNotifyAction(
                                                        person.id,
                                                        value
                                                    );
                                                }}
                                            />
                                        </label>
                                        {canManage ? (
                                            <>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    aria-label={t("people.addPhotoOf", { name: person.name })}
                                                    title={t("people.addPhoto")}
                                                    disabled={!ready || uploading === person.id}
                                                    onClick={() => pickPhoto(person)}
                                                >
                                                    {uploading === person.id ? (
                                                        <Loader2 className="size-4 shrink-0 animate-spin" />
                                                    ) : (
                                                        <ImagePlus className="size-4 shrink-0" />
                                                    )}
                                                </Button>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    aria-label={t("people.forgetName", { name: person.name })}
                                                    title={t("people.forget")}
                                                    onClick={() => setRemoving(person)}
                                                >
                                                    <Trash2 className="size-4 shrink-0" />
                                                </Button>
                                            </>
                                        ) : null}
                                    </div>
                                </li>
                            </ContextMenuTrigger>
                            <ContextMenuContent>
                                <ContextMenuLabel>{person.name}</ContextMenuLabel>
                                {canManage ? (
                                    <>
                                        <ContextMenuItem onSelect={() => startRename(person)}>
                                            <Pencil className="size-4 shrink-0" />
                                            {t("people.rename")}
                                        </ContextMenuItem>
                                        <ContextMenuItem
                                            disabled={!ready}
                                            onSelect={() => pickPhoto(person)}
                                        >
                                            <ImagePlus className="size-4 shrink-0" />
                                            {t("people.addPhoto")}
                                        </ContextMenuItem>
                                        <ContextMenuSeparator />
                                        <ContextMenuItem
                                            variant="danger"
                                            onSelect={() => setRemoving(person)}
                                        >
                                            <Trash2 className="size-4 shrink-0" />
                                            {t("people.forget")}
                                        </ContextMenuItem>
                                    </>
                                ) : (
                                    <ContextMenuItem disabled>
                                        {t("cameras.nothingToChange")}
                                    </ContextMenuItem>
                                )}
                            </ContextMenuContent>
                        </ContextMenu>
                    ))}
                </ul>
            )}

            {adding ? (
                <PersonDialog
                    recognizerReady={ready}
                    onClose={() => setAdding(false)}
                    onSaved={added}
                />
            ) : null}

            <input
                ref={fileInput}
                type="file"
                accept={FACE_IMAGE_TYPES.join(",")}
                className="hidden"
                onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void upload(file);
                }}
            />

            {removing ? (
                <ConfirmDeleteDialog
                    open
                    onOpenChange={(open) => !open && setRemoving(null)}
                    name={removing.name}
                    kind="person"
                    title={t("people.forgetTitle")}
                    question={t.rich("people.forgetQuestion", {
                        name: removing.name,
                        em: (chunks) => <span className="font-medium text-foreground">{chunks}</span>
                    })}
                    requireTyping={false}
                    description={t("people.forgetBody")}
                    confirmLabel={t("people.forget")}
                    onConfirm={() => remove(removing)}
                />
            ) : null}
        </div>
    );
}
