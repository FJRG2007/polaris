"use client";

/**
 * The account that takes this organization over.
 *
 * A person's successor answers for *their account*; this one answers for *this
 * organization*, and the difference is the reason it exists. An owner of four
 * organizations may well want a different person to close each one - the
 * colleague who ran it, rather than their brother - and until there was a row per
 * organization the only answer was the one on the account.
 *
 * **Naming nobody is a real answer.** With this unset the owner's own successor
 * still speaks for the organization, which is what happened before this card
 * existed and what most owners will never need to think about. So the card says
 * whose name is in force and where it came from, rather than showing an empty
 * box that reads as "nobody can ever close this".
 *
 * Only the owner sees it, and only the owner can write it. It is a decision about
 * what happens when they are gone, and a designation somebody holding
 * `settings.manage` could rewrite is not a designation.
 *
 * The dialog and the proof are the account card's, because they are the same
 * decision at a different scope - see `SuccessorCard` in account/security.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/avatar";
import type { StepUpProofInput } from "@polaris/core";
import { AccountInput } from "@/components/account-input";
import { StepUpFields } from "@/components/step-up-fields";
import { HeartHandshake, Loader2, Trash2, UserPlus } from "lucide-react";
import { clearOrgSuccessorAction, setOrgSuccessorAction } from "./successor-actions";
import {
    Button,
    Card,
    CardBody,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";

export interface OrgSuccessorPerson {
    userId: string;
    name: string;
    /** Their handle, or their address when they show it to the owner. Whom you
     *  named is your business; their address is still theirs. */
    contact: string;
    /** Whether this name came from the owner's own account rather than from this
     *  organization. The two must not read the same, or somebody will think they
     *  made a choice they have not. */
    inherited: boolean;
}

/** Which of the two things the dialog is open for. Null is closed. */
type Mode = "set" | "clear" | null;

export function OrgSuccessorCard({
    orgId,
    orgName,
    successor
}: {
    orgId: string;
    orgName: string;
    successor: OrgSuccessorPerson | null;
}) {
    const [mode, setMode] = useState<Mode>(null);
    const named = successor !== null && !successor.inherited;

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                        <h2 className="flex items-center gap-2 text-sm font-medium">
                            <HeartHandshake className="size-4 shrink-0" /> Successor
                        </h2>
                        <p className="text-muted-foreground text-xs">
                            Somebody who can close this organization if you are gone. They get
                            nothing else: not its work, not its roster, not a way to act as you.
                            Without one, whoever you named on your own account answers for it.
                        </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                        <Button size="sm" variant="secondary" onClick={() => setMode("set")}>
                            <UserPlus className="size-4 shrink-0" />
                            {named ? "Change" : "Name one"}
                        </Button>
                        {/* Only where there is one of this organization's own to
                            take off. Removing an inherited name would mean
                            reaching into the owner's account from here. */}
                        {named && (
                            <Button
                                size="sm"
                                variant="ghost"
                                aria-label="Remove this organization's successor"
                                title="Remove"
                                onClick={() => setMode("clear")}
                            >
                                <Trash2 className="size-4 shrink-0" />
                            </Button>
                        )}
                    </div>
                </div>

                {successor ? (
                    <div className="border-border flex items-center gap-3 rounded-md border px-3 py-2">
                        <Avatar person={{ id: successor.userId, name: successor.name }} size={32} />
                        <div className="min-w-0 flex-1">
                            <p className="truncate text-sm" title={successor.name}>
                                {successor.name}
                            </p>
                            <p
                                className="text-muted-foreground truncate text-xs"
                                title={successor.contact}
                            >
                                {successor.contact}
                            </p>
                        </div>
                        {successor.inherited ? (
                            <span className="text-muted-foreground shrink-0 text-[0.6875rem]">
                                From your account
                            </span>
                        ) : null}
                    </div>
                ) : (
                    <p className="border-border text-muted-foreground rounded-md border border-dashed px-3 py-4 text-center text-xs">
                        Nobody. Name somebody here, or on your own account, or this organization
                        cannot be closed once you are gone.
                    </p>
                )}
            </CardBody>

            <OrgSuccessorDialog
                mode={mode}
                orgId={orgId}
                orgName={orgName}
                current={named ? successor : null}
                onClose={() => setMode(null)}
            />
        </Card>
    );
}

function OrgSuccessorDialog({
    mode,
    orgId,
    orgName,
    current,
    onClose
}: {
    mode: Mode;
    orgId: string;
    orgName: string;
    current: OrgSuccessorPerson | null;
    onClose: () => void;
}) {
    const router = useRouter();
    const [identifier, setIdentifier] = useState("");
    const [proof, setProof] = useState<StepUpProofInput | null>(null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);

    const open = mode !== null;
    const clearing = mode === "clear";
    const ready = proof !== null && (clearing || identifier.trim().length > 0);

    const close = () => {
        setIdentifier("");
        setProof(null);
        setError("");
        onClose();
    };

    const submit = async () => {
        if (!proof) return;
        setBusy(true);
        setError("");
        const result = clearing
            ? await clearOrgSuccessorAction({ orgId, proof })
            : await setOrgSuccessorAction({ orgId, identifier: identifier.trim(), proof });
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        close();
        router.refresh();
    };

    return (
        <Dialog open={open} onOpenChange={(next) => !next && close()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>
                        {clearing
                            ? `Remove ${orgName}'s successor`
                            : current
                              ? `Change ${orgName}'s successor`
                              : `Name a successor for ${orgName}`}
                    </DialogTitle>
                </DialogHeader>
                <form
                    className="flex flex-col gap-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void submit();
                    }}
                >
                    {clearing ? (
                        <p className="text-muted-foreground text-sm">
                            {current?.name} stops answering for {orgName}. Whoever you named on your
                            own account takes over again, and you can name somebody here at any
                            time.
                        </p>
                    ) : (
                        <>
                            <label className="flex flex-col gap-1 text-sm">
                                Who
                                <AccountInput
                                    autoFocus
                                    value={identifier}
                                    className="h-9"
                                    placeholder="someone@example.com"
                                    aria-label="Search by username, full name, or email address"
                                    onValueChange={setIdentifier}
                                />
                            </label>
                            {/* Said before the button rather than behind a tick
                                box: the press is the consent, and a box beside it
                                is one more thing to tick without reading. */}
                            <p className="text-muted-foreground text-xs">
                                They will be able to delete {orgName} and everything in it. They
                                will not be able to read it, open it, or change anything in it
                                while you are here. This is not a will and does not outrank one.
                            </p>
                        </>
                    )}

                    <StepUpFields open={open} purpose="organization-successor" onChange={setProof} />
                    {error ? <p className="text-danger text-sm">{error}</p> : null}

                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={close}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!ready || busy}>
                            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                            {clearing ? "Remove" : "Name them"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
