"use client";

/**
 * The links a document is handed out on, inside the dialog that already says
 * "Share".
 *
 * Here rather than on a screen of its own because there is one question -
 * "who can open this" - and answering half of it in a dialog and half of it
 * somewhere else is how people end up sending a link they did not know was
 * still live.
 *
 * Two things this screen is careful about:
 *
 * - **The address is shown once, when the link is made.** It is offered again
 *   on demand rather than listed, because a list of live URLs is a screenshot
 *   away from being a leak, and the row already says everything somebody needs
 *   to decide whether to revoke it.
 * - **A revoked link stays on the list.** "Did we ever send this out" is a
 *   question people ask months later, and a row that disappears cannot answer
 *   it.
 */

import * as core from "@polaris/core";
import { useEffect, useState } from "react";
import { runAction } from "@/lib/run-action";
import { useConfirm } from "@/components/confirm-dialog";
import { refusalOf } from "@/app/(app)/mail/refusal";
import type { OfficeLinkView } from "@/lib/office/links";
import { Copy, Link2, Loader2, Plus, Trash2 } from "lucide-react";
import { Button, Input, Select, Switch, useToast } from "@polaris/ui";
import {
    createLinkAction,
    listLinksAction,
    revealLinkAction,
    revokeLinkAction
} from "./link-actions";

/** What each standing means, said as the person who made the link would say it. */
const STANDING: Record<OfficeLinkView["standing"], string> = {
    live: "Working",
    revoked: "Stopped",
    expired: "Out of date",
    exhausted: "All its openings used",
    scheduled: "Not started yet"
};

export function OfficeLinkPanel({ documentId }: { documentId: string }) {
    const toast = useToast();
    const [confirm, confirmDialog] = useConfirm();
    const [links, setLinks] = useState<OfficeLinkView[] | null>(null);
    const [busy, setBusy] = useState(false);
    const [making, setMaking] = useState(false);
    const [role, setRole] = useState<core.OfficeRole>("viewer");
    const [password, setPassword] = useState("");
    const [withPassword, setWithPassword] = useState(false);
    const [expiresAt, setExpiresAt] = useState("");
    const [note, setNote] = useState("");
    /** The address just made, shown once. Cleared as soon as it is copied or the
     *  form is opened again. */
    const [fresh, setFresh] = useState("");

    useEffect(() => {
        let current = true;
        void runAction(
            () => listLinksAction(documentId),
            (message) => toast.show({ title: message })
        ).then((answer) => {
            if (!current || !answer) return;
            if ("links" in answer) setLinks(answer.links);
            else setLinks([]);
        });
        return () => {
            current = false;
        };
    }, [documentId, toast]);

    async function copy(url: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(url);
            toast.show({ title: "The link is on your clipboard." });
        } catch {
            // A browser that refuses the clipboard is not a failure worth an
            // error: the address is on screen and can be selected.
            toast.show({ title: "Copy it from the box above." });
        }
    }

    async function make(): Promise<void> {
        setBusy(true);
        const answer = await runAction(
            () =>
                createLinkAction(documentId, {
                    role,
                    password: withPassword ? password : "",
                    expiresAt,
                    maxUses: null,
                    note
                }),
            (message) => toast.show({ title: message })
        );
        setBusy(false);
        if (!answer) return;
        const said = refusalOf(answer);
        if (said || !("url" in answer)) {
            toast.show({ title: said || "That link could not be made." });
            return;
        }
        setLinks(answer.links ?? []);
        setFresh(answer.url ?? "");
        setMaking(false);
        setPassword("");
        setWithPassword(false);
        setExpiresAt("");
        setNote("");
    }

    async function reveal(linkId: string): Promise<void> {
        const answer = await runAction(
            () => revealLinkAction(documentId, linkId),
            (message) => toast.show({ title: message })
        );
        if (!answer) return;
        const said = refusalOf(answer);
        if (said || !("url" in answer)) {
            toast.show({ title: said || "That link could not be read." });
            return;
        }
        await copy(answer.url ?? "");
    }

    async function revoke(link: OfficeLinkView): Promise<void> {
        const sure = await confirm({
            title: "Stop this link?",
            description:
                "Anybody who has it stops being able to open the document, at once. It stays on this list so you can see it existed.",
            confirmLabel: "Stop it",
            danger: true
        });
        if (!sure) return;
        const answer = await runAction(
            () => revokeLinkAction(documentId, link.id),
            (message) => toast.show({ title: message })
        );
        if (!answer) return;
        const said = refusalOf(answer);
        if (said || !("links" in answer)) {
            toast.show({ title: said || "That link could not be stopped." });
            return;
        }
        setLinks(answer.links ?? []);
    }

    return (
        <section className="border-t border-border pt-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                    <h3 className="text-[13px] font-medium">Anybody with the link</h3>
                    <p className="mt-0.5 text-[12px] text-muted-foreground">
                        For somebody who has no account here. A link can never share the document
                        on and can never delete it, whatever it lets them do.
                    </p>
                </div>
                <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                        setFresh("");
                        setMaking((held) => !held);
                    }}
                >
                    <Plus className="size-4 shrink-0" aria-hidden />
                    New link
                </Button>
            </div>

            {fresh ? (
                <div className="mt-3 rounded-md border border-primary/40 bg-primary/5 p-2">
                    <p className="mb-1 text-[12px] text-muted-foreground">
                        Copy it now. It is not shown again on its own, though you can ask for it.
                    </p>
                    <div className="flex items-center gap-2">
                        <Input readOnly value={fresh} onFocus={(event) => event.target.select()} />
                        <Button size="sm" onClick={() => void copy(fresh)}>
                            <Copy className="size-4 shrink-0" aria-hidden />
                            Copy
                        </Button>
                    </div>
                </div>
            ) : null}

            {making ? (
                <div className="mt-3 space-y-3 rounded-md border border-border p-3">
                    <label className="block">
                        <span className="mb-1 block text-[12px] text-muted-foreground">
                            What it lets them do
                        </span>
                        <Select
                            value={role}
                            onValueChange={(next) => setRole(next as core.OfficeRole)}
                            options={core.OFFICE_ROLES.map((one) => ({
                                value: one,
                                label: core.OFFICE_ROLE_LABELS[one]
                            }))}
                        />
                        <span className="mt-1 block text-[12px] text-foreground-subtle">
                            {core.OFFICE_ROLE_HINTS[role]}
                        </span>
                    </label>

                    <label className="flex items-center gap-2 text-[13px]">
                        <Switch
                            checked={withPassword}
                            onChange={setWithPassword}
                            aria-label="Ask for a password"
                        />
                        Ask for a password
                    </label>
                    {withPassword ? (
                        /* enigma:allow-no-breach-check enigma:allow-identity-password -
                           this is the link's own passphrase, not a credential: it
                           authenticates nobody, there is no account behind it to
                           compare against, and the person typing it here is the
                           one handing it out rather than the one it protects. */
                        <Input
                            type="password"
                            value={password}
                            autoComplete="new-password"
                            placeholder="What they will have to type"
                            onChange={(event) => setPassword(event.target.value)}
                        />
                    ) : null}

                    <label className="block">
                        <span className="mb-1 block text-[12px] text-muted-foreground">
                            Stop working on (optional)
                        </span>
                        <Input
                            type="date"
                            value={expiresAt}
                            onChange={(event) => setExpiresAt(event.target.value)}
                        />
                    </label>

                    <label className="block">
                        <span className="mb-1 block text-[12px] text-muted-foreground">
                            What it is for (only you see this)
                        </span>
                        <Input
                            value={note}
                            placeholder="The design review with Acme"
                            onChange={(event) => setNote(event.target.value)}
                        />
                    </label>

                    <div className="flex justify-end gap-2">
                        <Button size="sm" variant="secondary" onClick={() => setMaking(false)}>
                            Cancel
                        </Button>
                        <Button
                            size="sm"
                            disabled={busy || (withPassword && password.length === 0)}
                            onClick={() => void make()}
                        >
                            {busy ? (
                                <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                            ) : null}
                            Make the link
                        </Button>
                    </div>
                </div>
            ) : null}

            {links === null ? (
                <p className="mt-3 text-[12px] text-muted-foreground">Reading the links…</p>
            ) : links.length === 0 ? (
                <p className="mt-3 text-[12px] text-muted-foreground">
                    None yet. Everybody who opens this has an account here.
                </p>
            ) : (
                <ul className="mt-3 flex flex-col gap-1">
                    {links.map((link) => (
                        <li
                            key={link.id}
                            className="flex items-center gap-2 rounded-md border border-border px-2.5 py-2"
                        >
                            <Link2
                                className="size-4 shrink-0 text-muted-foreground"
                                aria-hidden
                            />
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-[13px]">
                                    {core.OFFICE_ROLE_LABELS[link.role]}
                                    {link.note ? ` - ${link.note}` : ""}
                                </p>
                                <p className="truncate text-[12px] text-foreground-subtle">
                                    {STANDING[link.standing]}
                                    {link.hasPassword ? ", password" : ""}
                                    {link.useCount > 0
                                        ? `, opened ${link.useCount} ${link.useCount === 1 ? "time" : "times"}`
                                        : ", never opened"}
                                </p>
                            </div>
                            {link.standing === "live" ? (
                                <Button
                                    size="icon-sm"
                                    variant="ghost"
                                    title="Copy the link"
                                    onClick={() => void reveal(link.id)}
                                >
                                    <Copy className="size-4 shrink-0" aria-hidden />
                                </Button>
                            ) : null}
                            {link.revokedAt ? null : (
                                <Button
                                    size="icon-sm"
                                    variant="ghost"
                                    title="Stop this link"
                                    onClick={() => void revoke(link)}
                                >
                                    <Trash2 className="size-4 shrink-0" aria-hidden />
                                </Button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {confirmDialog}
        </section>
    );
}
