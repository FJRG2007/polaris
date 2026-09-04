"use client";

/**
 * The three dialogs a shared notebook needs: making one, saying who can reach
 * it, and reading a vault of Markdown into it.
 *
 * Together rather than in three files because they are one idea - a notebook is
 * the thing that has people on it and the thing an import lands in - and each is
 * small enough that splitting them would mean three headers repeating the same
 * paragraph.
 */

import * as actions from "./actions";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import { useEffect, useRef, useState } from "react";
import { Import, Loader2, Trash2, Users } from "lucide-react";
import type { ShelfPerson, ShelfTeam } from "@/lib/notes/shelf-service";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    Select
} from "@polaris/ui";

const ROLES = [
    { value: "guest", label: "Can read" },
    { value: "member", label: "Can write" },
    { value: "admin", label: "Can run it" }
];

// ---------------------------------------------------------------------------
// Making one
// ---------------------------------------------------------------------------

export function NewNotebookDialog({
    open,
    onOpenChange
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const router = useRouter();
    const [name, setName] = useState("");
    const [orgId, setOrgId] = useState("");
    const [visibility, setVisibility] = useState("private");
    const [orgs, setOrgs] = useState<{ id: string; name: string }[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    // Asked for when the dialog opens rather than with the page: most people
    // belong to no organization, and the answer is then an empty list that hides
    // the picker entirely.
    useEffect(() => {
        if (!open) return;
        void actions.noteSpaceOwnersAction().then(setOrgs).catch(() => setOrgs([]));
    }, [open]);

    useEffect(() => {
        if (open) {
            setName("");
            setOrgId("");
            setVisibility("private");
            setError("");
        }
    }, [open]);

    const create = async () => {
        setBusy(true);
        const result = await runAction(
            () =>
                actions.createSpaceAction({
                    name: name.trim(),
                    visibility,
                    orgId: orgId || null
                }),
            setError
        );
        setBusy(false);
        if (result?.error) return;
        onOpenChange(false);
        router.refresh();
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>New notebook</DialogTitle>
                    <DialogDescription>
                        A shelf you can put other people on. Your own notes stay where they are.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        <span>
                            Name <span aria-hidden="true">*</span>
                        </span>
                        <Input
                            value={name}
                            autoFocus
                            placeholder="Engineering"
                            onChange={(event) => setName(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" && name.trim()) void create();
                            }}
                        />
                    </label>

                    {orgs.length > 0 && (
                        <label className="flex flex-col gap-1 text-sm">
                            <span>Belongs to</span>
                            <Select
                                value={orgId}
                                onValueChange={setOrgId}
                                placeholder="Me"
                                options={[
                                    { value: "", label: "Me" },
                                    ...orgs.map((org) => ({ value: org.id, label: org.name }))
                                ]}
                            />
                        </label>
                    )}

                    <label className="flex flex-col gap-1 text-sm">
                        <span>Who can find it</span>
                        <Select
                            value={visibility}
                            onValueChange={setVisibility}
                            options={[
                                { value: "private", label: "Only the people I add" },
                                {
                                    value: "internal",
                                    label: orgId ? "Everybody in the organization" : "Everybody here"
                                }
                            ]}
                        />
                    </label>
                </div>

                {error && (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                )}

                <DialogFooter>
                    <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button size="sm" disabled={busy || !name.trim()} onClick={() => void create()}>
                        {busy && <Loader2 className="size-4 animate-spin" />}
                        Make it
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// ---------------------------------------------------------------------------
// Who can reach it
// ---------------------------------------------------------------------------

export function NotebookPeopleDialog({
    spaceId,
    onOpenChange
}: {
    /** Null when nothing is open, which is also what closes it. */
    spaceId: string | null;
    onOpenChange: (spaceId: string | null) => void;
}) {
    const router = useRouter();
    const [people, setPeople] = useState<ShelfPerson[]>([]);
    const [teams, setTeams] = useState<ShelfTeam[]>([]);
    const [eligible, setEligible] = useState<{ id: string; name: string }[]>([]);
    const [query, setQuery] = useState("");
    const [found, setFound] = useState<{ id: string; name: string }[]>([]);
    const [error, setError] = useState("");
    const search = useRef<ReturnType<typeof setTimeout> | null>(null);

    const load = async (id: string) => {
        const result = await actions.spaceAccessAction(id);
        if (result.error) {
            setError(result.error);
            return;
        }
        setPeople(result.people ?? []);
        setTeams(result.teams ?? []);
        setEligible(result.eligibleTeams ?? []);
    };

    useEffect(() => {
        if (!spaceId) return;
        setError("");
        setQuery("");
        setFound([]);
        void load(spaceId);
    }, [spaceId]);

    // Typed rather than pressed: a picker that waits for a button is a picker
    // people give up on. Debounced so a name is one query rather than eight.
    useEffect(() => {
        if (search.current) clearTimeout(search.current);
        const term = query.trim();
        if (term.length < 2) {
            setFound([]);
            return;
        }
        search.current = setTimeout(async () => {
            const result = await actions.searchNotePeopleAction(term);
            setFound(result.results ?? []);
        }, 250);
        return () => {
            if (search.current) clearTimeout(search.current);
        };
    }, [query]);

    const act = async (run: () => Promise<{ error?: string }>) => {
        const result = await runAction(run, setError);
        if (!result?.error && spaceId) {
            await load(spaceId);
            router.refresh();
        }
    };

    const already = new Set(people.map((person) => person.userId));

    return (
        <Dialog open={spaceId !== null} onOpenChange={(next) => !next && onOpenChange(null)}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Who can reach this notebook</DialogTitle>
                    <DialogDescription>
                        Reading, writing, or running it. Whoever made it always can.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                        <Input
                            value={query}
                            placeholder="Find somebody by name"
                            aria-label="Find somebody by name"
                            onChange={(event) => setQuery(event.target.value)}
                        />
                        {found.length > 0 && (
                            <ul className="flex flex-col gap-0.5 rounded-md border border-border p-1">
                                {found
                                    .filter((person) => !already.has(person.id))
                                    .map((person) => (
                                        <li key={person.id}>
                                            <button
                                                type="button"
                                                className="w-full rounded px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted"
                                                onClick={() => {
                                                    setQuery("");
                                                    setFound([]);
                                                    void act(() =>
                                                        actions.grantSpaceAction({
                                                            spaceId,
                                                            userId: person.id,
                                                            role: "member"
                                                        })
                                                    );
                                                }}
                                            >
                                                {person.name}
                                            </button>
                                        </li>
                                    ))}
                            </ul>
                        )}
                    </div>

                    <ul className="flex flex-col gap-1">
                        {people.map((person) => (
                            <li key={person.userId} className="flex items-center gap-2">
                                <span className="min-w-0 flex-1 truncate text-sm" title={person.email}>
                                    {person.name}
                                    {person.owner && (
                                        <span className="ml-1 text-xs text-muted-foreground">owner</span>
                                    )}
                                </span>
                                {person.owner ? (
                                    <span className="text-xs text-muted-foreground">Runs it</span>
                                ) : (
                                    <>
                                        <Select
                                            value={person.role}
                                            options={ROLES}
                                            className="w-36"
                                            onValueChange={(role) =>
                                                void act(() =>
                                                    actions.grantSpaceAction({
                                                        spaceId,
                                                        userId: person.userId,
                                                        role
                                                    })
                                                )
                                            }
                                        />
                                        <button
                                            type="button"
                                            aria-label={`Take ${person.name} off this notebook`}
                                            title="Take off"
                                            onClick={() =>
                                                void act(() =>
                                                    actions.revokeSpaceAction({
                                                        spaceId,
                                                        userId: person.userId
                                                    })
                                                )
                                            }
                                            className="rounded p-1 text-muted-foreground transition-colors hover:text-danger"
                                        >
                                            <Trash2 className="size-3.5" />
                                        </button>
                                    </>
                                )}
                            </li>
                        ))}
                    </ul>

                    {eligible.length > 0 && (
                        <div className="flex flex-col gap-2">
                            <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                                <Users className="size-3.5" />
                                Teams
                            </p>
                            <ul className="flex flex-col gap-1">
                                {eligible.map((team) => {
                                    const grant = teams.find((row) => row.teamId === team.id);
                                    return (
                                        <li key={team.id} className="flex items-center gap-2">
                                            <span className="min-w-0 flex-1 truncate text-sm">
                                                {team.name}
                                            </span>
                                            <Select
                                                value={grant?.role ?? ""}
                                                placeholder="No access"
                                                className="w-36"
                                                options={ROLES}
                                                onValueChange={(role) =>
                                                    void act(() =>
                                                        actions.grantSpaceAction({
                                                            spaceId,
                                                            teamId: team.id,
                                                            role
                                                        })
                                                    )
                                                }
                                            />
                                            {grant && (
                                                <button
                                                    type="button"
                                                    aria-label={`Take ${team.name} off this notebook`}
                                                    title="Take off"
                                                    onClick={() =>
                                                        void act(() =>
                                                            actions.revokeSpaceAction({
                                                                spaceId,
                                                                teamId: team.id
                                                            })
                                                        )
                                                    }
                                                    className="rounded p-1 text-muted-foreground transition-colors hover:text-danger"
                                                >
                                                    <Trash2 className="size-3.5" />
                                                </button>
                                            )}
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>
                    )}
                </div>

                {error && (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                )}

                <DialogFooter>
                    <Button variant="ghost" size="sm" onClick={() => onOpenChange(null)}>
                        Done
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// ---------------------------------------------------------------------------
// Reading a vault in
// ---------------------------------------------------------------------------

export function ImportNotesDialog({
    target,
    onOpenChange
}: {
    /** Where the import lands, or null when nothing is open. */
    target: { spaceId: string | null; folderId: string | null; name: string } | null;
    onOpenChange: (target: null) => void;
}) {
    const router = useRouter();
    const [files, setFiles] = useState<FileList | null>(null);
    const [keepFolders, setKeepFolders] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [done, setDone] = useState<{ notes: number; folders: number; links: number; skipped: number } | null>(
        null
    );

    useEffect(() => {
        if (target) {
            setFiles(null);
            setError("");
            setDone(null);
        }
    }, [target]);

    const run = async () => {
        if (!files || files.length === 0 || !target) return;
        setBusy(true);
        setError("");
        const form = new FormData();
        if (target.spaceId) form.set("spaceId", target.spaceId);
        if (target.folderId) form.set("folderId", target.folderId);
        form.set("keepFolders", keepFolders ? "true" : "false");
        for (const file of Array.from(files)) form.append("files", file);

        const result = await runAction(() => actions.importNotesAction(form), setError);
        setBusy(false);
        if (!result || result.error) return;
        setDone({
            notes: result.notes ?? 0,
            folders: result.folders ?? 0,
            links: result.links ?? 0,
            skipped: result.skipped?.length ?? 0
        });
        router.refresh();
    };

    return (
        <Dialog open={target !== null} onOpenChange={(next) => !next && onOpenChange(null)}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Import Markdown</DialogTitle>
                    <DialogDescription>
                        Files, a folder, or a zipped vault. It lands in {target?.name ?? "this notebook"}.
                    </DialogDescription>
                </DialogHeader>

                {done ? (
                    <div className="flex flex-col gap-1 text-sm">
                        <p>
                            {done.notes === 1 ? "One note" : `${done.notes} notes`}
                            {done.folders > 0 &&
                                ` in ${done.folders === 1 ? "one folder" : `${done.folders} folders`}`}
                            .
                        </p>
                        {done.links > 0 && (
                            <p className="text-muted-foreground">
                                {done.links === 1 ? "One note's links" : `${done.links} notes' links`} now
                                point at the notes they name.
                            </p>
                        )}
                        {done.skipped > 0 && (
                            <p className="text-muted-foreground">
                                {done.skipped === 1 ? "One file was" : `${done.skipped} files were`} left
                                alone: only Markdown and plain text are read.
                            </p>
                        )}
                    </div>
                ) : (
                    <div className="flex flex-col gap-3">
                        <input
                            type="file"
                            multiple
                            accept=".md,.markdown,.mdx,.txt,.zip"
                            aria-label="The files to bring in"
                            onChange={(event) => setFiles(event.target.files)}
                            className="text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-field file:px-3 file:py-1.5 file:text-sm"
                        />
                        <label className="flex items-center gap-2 text-sm">
                            <input
                                type="checkbox"
                                checked={keepFolders}
                                onChange={(event) => setKeepFolders(event.target.checked)}
                            />
                            Keep the folders the files are in
                        </label>
                        <p className="text-xs text-muted-foreground">
                            Links written as [[another note]] are connected once everything is in.
                        </p>
                    </div>
                )}

                {error && (
                    <p role="alert" className="text-sm text-danger">
                        {error}
                    </p>
                )}

                <DialogFooter>
                    <Button variant="ghost" size="sm" onClick={() => onOpenChange(null)}>
                        {done ? "Done" : "Cancel"}
                    </Button>
                    {!done && (
                        <Button
                            size="sm"
                            disabled={busy || !files || files.length === 0}
                            onClick={() => void run()}
                        >
                            {busy ? <Loader2 className="size-4 animate-spin" /> : <Import className="size-4" />}
                            Bring them in
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
