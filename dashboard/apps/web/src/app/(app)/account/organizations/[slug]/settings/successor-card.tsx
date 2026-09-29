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
import { useTranslations } from "@/components/i18n/i18n-provider";
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
    const t = useTranslations("accountOrgs");
    const [mode, setMode] = useState<Mode>(null);
    const named = successor !== null && !successor.inherited;

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                        <h2 className="flex items-center gap-2 text-sm font-medium">
                            <HeartHandshake className="size-4 shrink-0" /> {t("successor.title")}
                        </h2>
                        <p className="text-muted-foreground text-xs">{t("successor.intro")}</p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                        <Button size="sm" variant="secondary" onClick={() => setMode("set")}>
                            <UserPlus className="size-4 shrink-0" />
                            {named ? t("successor.change") : t("successor.nameOne")}
                        </Button>
                        {/* Only where there is one of this organization's own to
                            take off. Removing an inherited name would mean
                            reaching into the owner's account from here. */}
                        {named && (
                            <Button
                                size="sm"
                                variant="ghost"
                                aria-label={t("successor.removeLabel")}
                                title={t("form.remove")}
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
                                {t("successor.fromAccount")}
                            </span>
                        ) : null}
                    </div>
                ) : (
                    <p className="border-border text-muted-foreground rounded-md border border-dashed px-3 py-4 text-center text-xs">
                        {t("successor.nobody")}
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
    const t = useTranslations("accountOrgs");
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
                            ? t("successor.dialog.removeTitle", { org: orgName })
                            : current
                              ? t("successor.dialog.changeTitle", { org: orgName })
                              : t("successor.dialog.nameTitle", { org: orgName })}
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
                            {t("successor.dialog.removeBody", { name: current?.name ?? "", org: orgName })}
                        </p>
                    ) : (
                        <>
                            <label className="flex flex-col gap-1 text-sm">
                                {t("successor.dialog.who")}
                                <AccountInput
                                    autoFocus
                                    value={identifier}
                                    className="h-9"
                                    placeholder={t("form.identifierPlaceholder")}
                                    aria-label={t("successor.dialog.search")}
                                    onValueChange={setIdentifier}
                                />
                            </label>
                            {/* Said before the button rather than behind a tick
                                box: the press is the consent, and a box beside it
                                is one more thing to tick without reading. */}
                            <p className="text-muted-foreground text-xs">
                                {t("successor.dialog.warning", { org: orgName })}
                            </p>
                        </>
                    )}

                    <StepUpFields open={open} purpose="organization-successor" onChange={setProof} />
                    {error ? <p className="text-danger text-sm">{error}</p> : null}

                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={close}>
                            {t("form.cancel")}
                        </Button>
                        <Button type="submit" disabled={!ready || busy}>
                            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                            {clearing ? t("form.remove") : t("successor.dialog.nameThem")}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
