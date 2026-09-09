"use client";

/**
 * "Which of your folders is the Trash?"
 *
 * Asked once per mailbox, the first time an action needs a folder Polaris cannot
 * find. It exists because the alternative was worse: Polaris used to make the
 * folder itself, so a mailbox whose trash is called `Papelera` ended up with a
 * second, empty `Trash` written into the mail server, which its owner then saw
 * in every other client they use.
 *
 * The reader's own folders come first and the answer sticks - it survives every
 * later sync. Making one is still offered, because a mailbox genuinely without
 * an Archive is common, but it is a button that says it will write to the mail
 * server rather than something that happens quietly.
 */

import * as core from "@polaris/core";
import { refusalOf } from "./refusal";
import { useMail } from "./mail-shell";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { FolderPlus, Loader2 } from "lucide-react";
import { createFolderForRoleAction, setFolderRoleAction } from "./actions";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, cn, useToast } from "@polaris/ui";

/** What an action asked for and could not find. */
export interface MissingFolderRole {
    readonly role: string;
    readonly accountId: string;
}

export function FolderRoleDialog({
    missing,
    onClose,
    onSettled
}: {
    missing: MissingFolderRole;
    onClose: () => void;
    /** Called once a folder holds the role, so the caller can try again. */
    onSettled: () => void;
}) {
    const router = useRouter();
    const toast = useToast();
    const { accounts, folders } = useMail();
    const [chosen, setChosen] = useState("");
    const [working, startWorking] = useTransition();

    const account = accounts.find((one) => one.id === missing.accountId);
    const label = core.MAIL_FOLDER_ROLE_LABELS[missing.role] ?? missing.role;
    // The account's own folders, minus the ones already spoken for, so the list
    // is the plausible answers rather than everything.
    const candidates = folders.filter(
        (folder) => folder.accountId === missing.accountId && (folder.role === "none" || folder.role === missing.role)
    );

    function settle(run: () => Promise<unknown>): void {
        startWorking(async () => {
            const answer = await run();
            const said = refusalOf(answer);
            if (said) {
                toast.show({ title: said });
                return;
            }
            router.refresh();
            onSettled();
            onClose();
        });
    }

    return (
        <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Which folder is your {label}?</DialogTitle>
                </DialogHeader>

                <p className="text-[13px] text-muted-foreground">
                    {account?.address ?? "This mailbox"} does not have a folder Polaris recognises as its{" "}
                    {label.toLowerCase()}. Point at the one you already use and it will remember, on this mailbox
                    and through every later check.
                </p>

                {candidates.length > 0 ? (
                    <ul className="mt-3 max-h-64 space-y-1 overflow-y-auto overscroll-contain">
                        {candidates.map((folder) => (
                            <li key={folder.id}>
                                <button
                                    type="button"
                                    aria-pressed={chosen === folder.id}
                                    onClick={() => setChosen(folder.id)}
                                    className={cn(
                                        "w-full rounded-md border px-3 py-2 text-left text-[13px]",
                                        chosen === folder.id
                                            ? "border-primary bg-card text-foreground"
                                            : "border-border text-muted-foreground hover:bg-card hover:text-foreground"
                                    )}
                                >
                                    {folder.path}
                                </button>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="mt-3 text-[13px] text-foreground-subtle">
                        This mailbox has no other folders to choose from.
                    </p>
                )}

                <div className="mt-4 flex flex-wrap gap-2">
                    <Button
                        disabled={!chosen || working}
                        onClick={() => settle(() => setFolderRoleAction(chosen, missing.role))}
                    >
                        {working ? <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden /> : null}
                        Use this one
                    </Button>
                    <Button
                        variant="secondary"
                        disabled={working}
                        onClick={() => settle(() => createFolderForRoleAction(missing.accountId, missing.role))}
                    >
                        <FolderPlus className="size-4 shrink-0" aria-hidden />
                        Make one on the mail server
                    </Button>
                    <Button variant="ghost" disabled={working} onClick={onClose}>
                        Not now
                    </Button>
                </div>
                <p className="mt-2 text-[12px] text-foreground-subtle">
                    Making one adds a folder to your mail server, which you will see in every other mail client
                    you use.
                </p>
            </DialogContent>
        </Dialog>
    );
}
