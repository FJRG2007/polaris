"use client";

/**
 * Putting a note on the internet, and the settings that narrow who reaches it.
 *
 * One switch and then the detail, because the question people open this with is
 * "is this published" and everything else is an answer to a second question. The
 * address is at the top the moment it exists: what somebody does with this dialog
 * is copy one line out of it.
 *
 * The rules are the ones every public link in Polaris offers, edited by the same
 * component the Drive share and the drop points use - so a password on a note
 * behaves like a password on a file, and a fix to that editor reaches all of them.
 */

import * as actions from "./actions";
import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import { Globe, Link2, Lock } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import type { NoteShareView } from "@/lib/notes/share-service";
import { AccessRulesEditor, EMPTY_ACCESS_RULES } from "@/components/access-rules-editor";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input,
    Switch
} from "@polaris/ui";

/** A date the browser's date field can hold, from a stored instant. */
function asDateField(iso: string | null): string {
    return iso ? (iso.slice(0, 10) ?? "") : "";
}

export function NoteShareDialog({
    noteId,
    noteTitle,
    open,
    onOpenChange
}: {
    noteId: string;
    noteTitle: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const [share, setShare] = useState<NoteShareView | null>(null);
    const [url, setUrl] = useState("");
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    // The settings being edited. Held apart from `share` so a half-typed
    // password is never what the screen reports as the link's state.
    const [includeChildren, setIncludeChildren] = useState(true);
    const [password, setPassword] = useState("");
    const [maxViews, setMaxViews] = useState("");
    const [expires, setExpires] = useState("");
    const [rules, setRules] = useState(EMPTY_ACCESS_RULES);

    useEffect(() => {
        if (!open) return;
        let alive = true;
        setLoading(true);
        void actions.noteShareAction(noteId).then(async (result) => {
            if (!alive) return;
            if (result.error) setError(result.error);
            const found = result.share ?? null;
            setShare(found);
            if (found) {
                setIncludeChildren(found.includeChildren);
                setMaxViews(found.maxViews === null ? "" : String(found.maxViews));
                setExpires(asDateField(found.expiresAt));
                setRules({
                    groupIds: [],
                    allowedCidrs: [...found.allowedCidrs],
                    allowedCountries: [...found.allowedCountries],
                    allowedContinents: [...found.allowedContinents]
                });
                const link = await actions.revealNoteShareAction(noteId);
                if (alive && link.url) setUrl(link.url);
            }
            setLoading(false);
        });
        return () => {
            alive = false;
        };
    }, [open, noteId]);

    async function save(): Promise<void> {
        setBusy(true);
        const result = await runAction(
            () =>
                actions.publishNoteAction(noteId, {
                    includeChildren,
                    ...(password ? { password } : {}),
                    ...(maxViews ? { maxViews: Number(maxViews) } : { clearMaxViews: true }),
                    ...(expires ? { expiresAt: expires } : { clearExpiry: true }),
                    allowedCidrs: rules.allowedCidrs,
                    allowedCountries: rules.allowedCountries,
                    allowedContinents: rules.allowedContinents
                }),
            setError
        );
        setBusy(false);
        if (result?.share) {
            setShare(result.share);
            setPassword("");
            if (result.url) setUrl(result.url);
        }
    }

    async function unpublish(): Promise<void> {
        setBusy(true);
        const result = await runAction(() => actions.unpublishNoteAction(noteId), setError);
        setBusy(false);
        if (!result?.error) {
            setShare(null);
            setUrl("");
            setPassword("");
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>Share this note</DialogTitle>
                    <DialogDescription>
                        A link anybody can open, whether or not they have an account here. They can read
                        &ldquo;{noteTitle}&rdquo; and nothing else, and they cannot change it.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <div className="flex items-center gap-3 rounded-md border border-border bg-surface p-3">
                        <Globe className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 text-sm">
                            {share ? "Anyone with the link can read it" : "Not shared"}
                        </span>
                        <Switch
                            checked={Boolean(share)}
                            disabled={busy || loading}
                            aria-label="Share this note by link"
                            onChange={(checked) => void (checked ? save() : unpublish())}
                        />
                    </div>

                    {share && (
                        <>
                            <div className="flex items-center gap-2">
                                <Link2 className="size-4 shrink-0 text-muted-foreground" />
                                <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">
                                    {url || "..."}
                                </code>
                                {url && <CopyButton value={url} label="Copy the link" />}
                            </div>

                            {!share.usable.ok && (
                                <p className="rounded-md bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
                                    Nobody can open this link right now: it is {share.usable.reason}.
                                </p>
                            )}

                            <label className="flex items-center gap-3 text-sm">
                                <Switch
                                    checked={includeChildren}
                                    aria-label="Include the pages under this one"
                                    onChange={setIncludeChildren}
                                />
                                Include the pages under this one
                            </label>

                            <div className="grid grid-cols-2 gap-3">
                                <div className="flex flex-col gap-1">
                                    <span className="text-xs text-muted-foreground">
                                        <Lock className="mr-1 inline size-3" />
                                        {share.hasPassword ? "Replace the password" : "Password"}
                                    </span>
                                    {/* enigma:allow-no-breach-check enigma:allow-identity-password -
                                        this is the link's own passphrase, not a credential: it
                                        authenticates nobody, there is no account behind it to
                                        compare against, and guesses at it are limited per link
                                        per address in `unlockNoteShareAction`. */}
                                    <Input
                                        type="password"
                                        value={password}
                                        placeholder={share.hasPassword ? "Set" : "None"}
                                        autoComplete="new-password"
                                        onChange={(event) => setPassword(event.target.value)}
                                    />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <span className="text-xs text-muted-foreground">Expires on</span>
                                    <Input
                                        type="date"
                                        value={expires}
                                        onChange={(event) => setExpires(event.target.value)}
                                    />
                                </div>
                                <div className="flex flex-col gap-1">
                                    <span className="text-xs text-muted-foreground">
                                        Opens allowed ({share.viewCount} so far)
                                    </span>
                                    <Input
                                        type="number"
                                        min={1}
                                        value={maxViews}
                                        placeholder="No limit"
                                        onChange={(event) => setMaxViews(event.target.value)}
                                    />
                                </div>
                            </div>

                            <AccessRulesEditor value={rules} groups={[]} showGroups={false} onChange={setRules} />

                            {error && <p className="text-sm text-danger">{error}</p>}

                            <div className="flex items-center justify-between gap-2">
                                <Button variant="ghost" disabled={busy} onClick={() => void unpublish()}>
                                    Stop sharing
                                </Button>
                                <Button disabled={busy} onClick={() => void save()}>
                                    Save
                                </Button>
                            </div>
                        </>
                    )}

                    {!share && error && <p className="text-sm text-danger">{error}</p>}
                </div>
            </DialogContent>
        </Dialog>
    );
}
