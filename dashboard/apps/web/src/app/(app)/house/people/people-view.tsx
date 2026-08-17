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

import * as actions from "../actions";
import { runAction } from "@/lib/run-action";
import { useEffect, useRef, useState } from "react";
import type { PersonView } from "@/lib/home/people";
import { ImagePlus, Loader2, ScanFace, Trash2 } from "lucide-react";
import { Badge, Button, ConfirmDeleteDialog, EmptyState, Input, Skeleton, Switch } from "@polaris/ui";

export function PeopleView({ canManage }: { canManage: boolean }) {
    const [people, setPeople] = useState<PersonView[] | null>(null);
    const [ready, setReady] = useState(true);
    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);
    const [uploading, setUploading] = useState<string | null>(null);
    const [removing, setRemoving] = useState<PersonView | null>(null);
    const [error, setError] = useState<string | null>(null);
    const fileInput = useRef<HTMLInputElement | null>(null);
    const uploadFor = useRef<string | null>(null);

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

    const add = async () => {
        if (!name.trim()) return;
        setBusy(true);
        const result = await runAction(() => actions.addPersonAction(name), setError);
        setBusy(false);
        if (!result || result.error || !result.person) {
            if (result?.error) setError(result.error);
            return;
        }
        setPeople((current) => [...(current ?? []), result.person!].sort((a, b) => a.name.localeCompare(b.name)));
        setName("");
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
        const result = await runAction(() => actions.addFaceAction(id, bytes), setError);
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

    if (people === null) return <Skeleton className="h-48 w-full" />;

    return (
        <div className="flex flex-col gap-4">
            {!ready ? (
                <p className="rounded-lg border border-border bg-surface px-3 py-2 text-[12px] text-muted-foreground">
                    Face recognition is not set up yet. Install it from the marketplace and paste its key under
                    Settings; names written here will start working the moment you do.
                </p>
            ) : null}

            {canManage ? (
                <div className="flex flex-wrap gap-2">
                    <Input
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        placeholder="Their name"
                        className="w-56"
                        aria-label="Their name"
                        onKeyDown={(event) => {
                            if (event.key === "Enter") void add();
                        }}
                    />
                    <Button onClick={add} disabled={busy || !name.trim()}>
                        {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                        Add somebody
                    </Button>
                </div>
            ) : null}

            {error ? <p className="text-[12px] text-danger">{error}</p> : null}

            {people.length === 0 ? (
                <EmptyState
                    icon={<ScanFace />}
                    title="Nobody yet"
                    description="Add the people who live here, give each of them a few photographs, and the cameras stop reporting them as strangers."
                />
            ) : (
                <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
                    {people.map((person) => (
                        <li key={person.id} className="flex items-center justify-between gap-3 px-3 py-2">
                            <div className="min-w-0">
                                <p className="truncate text-[13px] text-foreground" title={person.name}>{person.name}</p>
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
                    ))}
                </ul>
            )}

            <input
                ref={fileInput}
                type="file"
                accept="image/jpeg,image/png"
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
