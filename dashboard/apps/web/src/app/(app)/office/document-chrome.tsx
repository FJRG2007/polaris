"use client";

/**
 * What is around a document, whichever of the five it is.
 *
 * The name, who may do what with it, the way back and the way to share it. One
 * component because it is one bar: a document, a spreadsheet, a deck, a diagram
 * and a comparison differ entirely inside the editor and not at all around it,
 * and five copies of a title bar is five places for the rename to behave
 * slightly differently.
 *
 * Full height and its own scrolling, like Mail and Chat: the editor below has to
 * be able to scroll inside itself with the title bar staying put, and a document
 * that scrolled the page would put the toolbar off the top of the screen on the
 * second paragraph.
 */

import Link from "next/link";
import * as core from "@polaris/core";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ShareDialog } from "@/components/access/share-dialog";
import { Button, PAGE_BLEED, cn, useToast } from "@polaris/ui";
import type { OfficeDocumentView } from "@/lib/office/documents";
import { renameDocumentAction, starDocumentAction } from "./actions";
import { ArrowLeft, Loader2, Share2, Star, Users } from "lucide-react";

export function DocumentChrome({
    document: row,
    role,
    owned,
    children
}: {
    document: OfficeDocumentView;
    role: core.OfficeRole;
    /** Whether it is theirs, which is what sharing and deleting take. */
    owned: boolean;
    children: React.ReactNode;
}) {
    const router = useRouter();
    const toast = useToast();
    const [title, setTitle] = useState(row.title);
    const [starred, setStarred] = useState(row.starred);
    const [sharing, setSharing] = useState(false);
    const [saving, setSaving] = useState(false);
    const settled = useRef(row.title);

    // The name follows the document when the browser navigates between two of
    // them without unmounting this.
    useEffect(() => {
        setTitle(row.title);
        settled.current = row.title;
        setStarred(row.starred);
    }, [row.id, row.title, row.starred]);

    const editable = core.officeRoleAtLeast(role, "editor");

    /** Renamed when the field is left rather than on every keystroke, and only
     *  when it actually differs: a name clicked into and out of is not a
     *  change, and writing one would put this account's name on somebody
     *  else's document as the last editor. */
    const rename = async (): Promise<void> => {
        const wanted = title.trim();
        if (!editable || wanted === settled.current) return;
        setSaving(true);
        const answer = await renameDocumentAction(row.id, wanted);
        setSaving(false);
        if (answer.error) {
            setTitle(settled.current);
            toast.show({ title: answer.error });
            return;
        }
        settled.current = answer.title ?? wanted;
        setTitle(settled.current);
        router.refresh();
    };

    return (
        <div className={cn(PAGE_BLEED, "flex min-h-0 flex-col")}>
            <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
                <Button variant="ghost" size="icon" asChild aria-label="Back to Office" title="Back">
                    <Link href="/office">
                        <ArrowLeft className="size-4 shrink-0" aria-hidden />
                    </Link>
                </Button>

                {/* The title is the field, not a field beside a heading. Renaming
                    a document is the most ordinary thing anybody does to one, and
                    putting it behind a dialog is what makes people leave "Untitled
                    document" on things for months. */}
                <input
                    value={title}
                    readOnly={!editable}
                    aria-label="Name of this document"
                    className="min-w-0 flex-1 rounded-md bg-transparent px-2 py-1 text-[15px] font-medium text-foreground outline-none focus:bg-surface-hover read-only:cursor-default"
                    onChange={(event) => setTitle(event.target.value)}
                    onBlur={() => void rename()}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                        if (event.key === "Escape") {
                            setTitle(settled.current);
                            event.currentTarget.blur();
                        }
                    }}
                />

                {saving ? (
                    <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
                ) : null}

                {/* What somebody who was given this can actually do, said plainly.
                    A reader who cannot type needs to know that before they try. */}
                {!owned ? (
                    <span className="hidden items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-[12px] text-muted-foreground sm:flex">
                        <Users className="size-3.5 shrink-0" aria-hidden />
                        {core.OFFICE_ROLE_LABELS[role]}
                    </span>
                ) : null}

                <Button
                    variant="ghost"
                    size="icon"
                    aria-pressed={starred}
                    aria-label={starred ? "Unstar this" : "Star this"}
                    title={starred ? "Unstar" : "Star"}
                    onClick={async () => {
                        const next = !starred;
                        setStarred(next);
                        const answer = await starDocumentAction(row.id, next);
                        if (answer.error) {
                            setStarred(!next);
                            toast.show({ title: answer.error });
                        }
                    }}
                >
                    <Star
                        className={cn("size-4 shrink-0", starred && "fill-current text-warning")}
                        aria-hidden
                    />
                </Button>

                {owned ? (
                    <Button size="sm" variant="secondary" onClick={() => setSharing(true)}>
                        <Share2 className="size-4 shrink-0" aria-hidden />
                        Share
                    </Button>
                ) : null}
            </header>

            {children}

            {sharing ? (
                <ShareDialog
                    open
                    onOpenChange={setSharing}
                    subject="office.document"
                    subjectId={row.id}
                    name={title}
                />
            ) : null}
        </div>
    );
}
