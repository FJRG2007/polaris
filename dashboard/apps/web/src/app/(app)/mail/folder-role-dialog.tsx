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
import { useState } from "react";
import { useBusy } from "./use-busy";
import { mailOptionLabel } from "./option-label";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { FolderPlus, Loader2 } from "lucide-react";
import { createFolderForRoleAction, setFolderRoleAction } from "./actions";
import {
    Button,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    cn,
    useToast
} from "@polaris/ui";

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
    const [working, startWorking] = useBusy();
    const t = useTranslations("mail");

    const account = accounts.find((one) => one.id === missing.accountId);
    const label = missing.role in core.MAIL_FOLDER_ROLE_LABELS ? mailOptionLabel(t, "folderRole", missing.role) : missing.role;
    // The account's own folders, minus the ones already spoken for, so the list
    // is the plausible answers rather than everything.
    const candidates = folders.filter(
        (folder) =>
            folder.accountId === missing.accountId &&
            (folder.role === "none" || folder.role === missing.role)
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
                    <DialogTitle>{t("folderRole.title", { label })}</DialogTitle>
                </DialogHeader>

                <p className="text-[13px] text-muted-foreground">
                    {t("folderRole.body", {
                        mailbox: account?.address ?? t("folderRole.thisMailbox"),
                        label: label.toLowerCase()
                    })}
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
                        {t("folderRole.noOthers")}
                    </p>
                )}

                <div className="mt-4 flex flex-wrap gap-2">
                    <Button
                        disabled={!chosen || working}
                        onClick={() => settle(() => setFolderRoleAction(chosen, missing.role))}
                    >
                        {working ? (
                            <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
                        ) : null}
                        {t("folderRole.use")}
                    </Button>
                    <Button
                        variant="secondary"
                        disabled={working}
                        onClick={() =>
                            settle(() => createFolderForRoleAction(missing.accountId, missing.role))
                        }
                    >
                        <FolderPlus className="size-4 shrink-0" aria-hidden />
                        {t("folderRole.make")}
                    </Button>
                    <Button variant="ghost" disabled={working} onClick={onClose}>
                        {t("folderRole.notNow")}
                    </Button>
                </div>
                <p className="mt-2 text-[12px] text-foreground-subtle">
                    {t("folderRole.makeHint")}
                </p>
            </DialogContent>
        </Dialog>
    );
}
