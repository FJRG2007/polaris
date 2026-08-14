"use client";

/**
 * The account that takes over this one.
 *
 * A designation rather than a permission, and the card says so plainly: naming
 * somebody here does not let them read your work, open your organizations or
 * sign in as you. What it does is let them end the organizations you own, which
 * is the thing that otherwise cannot happen at all once the only person allowed
 * to do it is gone.
 *
 * The acknowledgement sits above the button rather than behind a checkbox,
 * because the click is the consent and a checkbox next to it is one more thing
 * to tick without reading. It is deliberately unhedged about what this is and is
 * not: somebody arranging their estate is entitled to know that this is not a
 * will and does not outrank one.
 *
 * Both naming and removing ask for the same proof the successor's own powers
 * ask for. Otherwise a session left open on a borrowed laptop could name itself
 * and then use that to delete everything the account owns, and the confirmation
 * on the deleting end would be worth nothing.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/avatar";
import type { StepUpProofInput } from "@polaris/core";
import { AccountInput } from "@/components/account-input";
import { StepUpFields } from "@/components/step-up-fields";
import { Feedback, type SettingLock } from "./setting-card";
import { HeartHandshake, Loader2, Trash2, UserPlus } from "lucide-react";
import { clearSuccessorAction, setSuccessorAction } from "./successor-actions";
import { Button, Card, CardBody, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@polaris/ui";

export interface SuccessorPerson {
    userId: string;
    name: string;
    email: string;
}

/** Which of the two things the dialog is open for. Null is closed. */
type Mode = "set" | "clear" | null;

export function SuccessorCard({ successor, lock }: { successor: SuccessorPerson | null; lock?: SettingLock }) {
    const [mode, setMode] = useState<Mode>(null);

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                        <h2 className="flex items-center gap-2 text-sm font-medium">
                            <HeartHandshake className="size-4 shrink-0" /> Successor
                        </h2>
                        <p className="text-muted-foreground text-xs">
                            Somebody who can close the organizations you own if you die. They get nothing else: not
                            your work, not your sessions, not a way to sign in as you.
                        </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                        {lock ? (
                            <span className="text-muted-foreground text-xs">{lock.reason}</span>
                        ) : (
                            <>
                                <Button size="sm" variant="secondary" onClick={() => setMode("set")}>
                                    <UserPlus className="size-4 shrink-0" />
                                    {successor ? "Change" : "Add successor"}
                                </Button>
                                {successor && (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        aria-label="Remove your successor"
                                        title="Remove"
                                        onClick={() => setMode("clear")}
                                    >
                                        <Trash2 className="size-4 shrink-0" />
                                    </Button>
                                )}
                            </>
                        )}
                    </div>
                </div>

                {successor ? (
                    <div className="border-border flex items-center gap-3 rounded-md border px-3 py-2">
                        <Avatar person={{ id: successor.userId, name: successor.name }} size={32} />
                        <div className="min-w-0">
                            <p className="truncate text-sm" title={successor.name}>{successor.name}</p>
                            <p className="text-muted-foreground truncate text-xs" title={successor.email}>{successor.email}</p>
                        </div>
                    </div>
                ) : (
                    <p className="border-border text-muted-foreground rounded-md border border-dashed px-3 py-4 text-center text-xs">
                        You have not designated a successor.
                    </p>
                )}
            </CardBody>

            <SuccessorDialog mode={mode} current={successor} onClose={() => setMode(null)} />
        </Card>
    );
}

function SuccessorDialog({
    mode,
    current,
    onClose
}: {
    mode: Mode;
    current: SuccessorPerson | null;
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
            ? await clearSuccessorAction({ proof })
            : await setSuccessorAction({ identifier: identifier.trim(), proof });
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
                        {clearing ? "Remove your successor" : current ? "Change your successor" : "Add a successor"}
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
                            {current?.name} stops being able to close the organizations you own. You can name somebody
                            again at any time.
                        </p>
                    ) : (
                        <label className="text-muted-foreground flex flex-col gap-1 text-xs">
                            Search by username, full name, or email address
                            <AccountInput
                                autoFocus
                                value={identifier}
                                className="h-9"
                                placeholder="someone@example.com"
                                aria-label="Search by username, full name, or email address"
                                onValueChange={setIdentifier}
                            />
                        </label>
                    )}

                    <StepUpFields open={open} purpose="account-successor" onChange={setProof} />

                    {!clearing && (
                        <p className="text-muted-foreground text-xs">
                            By adding a successor you acknowledge that you own this account, and you authorize Polaris
                            to let the person named above close the organizations you own in the event of your death.
                            This does not override next-of-kin rules or estate law where you live, and it is not a
                            will.
                        </p>
                    )}

                    <Feedback error={error} />

                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={close} disabled={busy}>
                            Cancel
                        </Button>
                        <Button type="submit" variant={clearing ? "danger" : "primary"} disabled={busy || !ready}>
                            {busy && <Loader2 className="size-4 shrink-0 animate-spin" />}
                            {clearing ? "Remove" : current ? "Change successor" : "Add successor"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
