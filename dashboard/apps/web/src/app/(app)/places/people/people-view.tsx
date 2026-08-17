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
import { runAction } from "@/lib/run-action";
import { PersonDialog } from "./person-dialog";
import { useEffect, useRef, useState } from "react";
import type { PersonView } from "@/lib/home/people";
import { focusAfterMove } from "@/lib/list-selection";
import { FACE_IMAGE_TYPES } from "@/lib/home/face-image";
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

export function PeopleView({ canManage }: { canManage: boolean }) {
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
        setPeople((current) => [...(current ?? []), person].sort((a, b) => a.name.localeCompare(b.name)));
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
            (current ?? []).map((person) => (person.id === id ? { ...person, faces: person.faces + 1 } : person))
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
            (current ?? []).map((item) => (item.id === person.id ? { ...item, name: wanted } : item))
        );
        const result = await runAction(() => actions.renamePersonAction(person.id, wanted), setError);
        if (result?.error) {
            setError(result.error);
            setPeople((current) =>
                (current ?? []).map((item) => (item.id === person.id ? { ...item, name: person.name } : item))
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

    if (people === null) return <Skeleton className="h-48 w-full" />;

    return (
        <div className="flex flex-col gap-4">
            {!ready ? (
                <p className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-[12px] text-muted-foreground">
                    Nothing is recognizing faces yet. Names written here start working the moment something is.
                    <Button asChild variant="secondary" size="sm">
                        <Link href="/places/settings">Set it up</Link>
                    </Button>
                </p>
            ) : null}

            {canManage ? (
                <div className="flex flex-wrap gap-2">
                    <Button onClick={() => setAdding(true)}>
                        <UserPlus className="size-4 shrink-0" />
                        Add somebody
                    </Button>
                </div>
            ) : null}

            {error ? <p className="text-[12px] text-danger">{error}</p> : null}

            {people.length === 0 ? (
                <EmptyState
                    icon={<ScanFace />}
                    title="Nobody yet"
                    description="Add the people who live here with a few photographs each, and the cameras stop reporting them as strangers."
                    action={
                        canManage ? (
                            <Button size="sm" onClick={() => setAdding(true)}>
                                <UserPlus className="size-4 shrink-0" />
                                Add somebody
                            </Button>
                        ) : undefined
                    }
                />
            ) : (
                <ul
                    tabIndex={0}
                    onKeyDown={onKeyDown}
                    aria-label="People"
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
                                                aria-label={`Name for ${person.name}`}
                                                className="h-7 text-[13px]"
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
                                            <p className="truncate text-[13px] text-foreground" title={person.name}>{person.name}</p>
                                        )}
                                        <p className="truncate text-[11px] text-foreground-subtle">
                                            {person.faces === 0
                                                ? "No photographs yet - they will still be reported as a stranger"
                                                : `${person.faces} photograph${person.faces === 1 ? "" : "s"}`}
                                        </p>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-2">
                                        {person.faces > 0 && person.faces < 3 ? (
                                            <Badge variant="warning" title="A few photographs recognize a person; one recognizes a photograph">
                                                Add more
                                            </Badge>
                                        ) : null}
                                        <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                                            Tell me
                                            <Switch
                                                checked={person.notify}
                                                aria-label={`Report when ${person.name} is seen`}
                                                onChange={(value) => {
                                                    setPeople((current) =>
                                                        (current ?? []).map((item) =>
                                                            item.id === person.id ? { ...item, notify: value } : item
                                                        )
                                                    );
                                                    void actions.setPersonNotifyAction(person.id, value);
                                                }}
                                            />
                                        </label>
                                        {canManage ? (
                                            <>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    aria-label={`Add a photograph of ${person.name}`}
                                                    title="Add a photograph"
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
                                                    aria-label={`Forget ${person.name}`}
                                                    title="Forget them"
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
                                            Rename
                                        </ContextMenuItem>
                                        <ContextMenuItem disabled={!ready} onSelect={() => pickPhoto(person)}>
                                            <ImagePlus className="size-4 shrink-0" />
                                            Add a photograph
                                        </ContextMenuItem>
                                        <ContextMenuSeparator />
                                        <ContextMenuItem variant="danger" onSelect={() => setRemoving(person)}>
                                            <Trash2 className="size-4 shrink-0" />
                                            Forget them
                                        </ContextMenuItem>
                                    </>
                                ) : (
                                    <ContextMenuItem disabled>Nothing to change here</ContextMenuItem>
                                )}
                            </ContextMenuContent>
                        </ContextMenu>
                    ))}
                </ul>
            )}

            {adding ? (
                <PersonDialog recognizerReady={ready} onClose={() => setAdding(false)} onSaved={added} />
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
                    requireTyping={false}
                    description="Their photographs are deleted from the recognizer as well. The cameras will report them as a stranger from then on."
                    confirmLabel="Forget them"
                    onConfirm={() => remove(removing)}
                />
            ) : null}
        </div>
    );
}
