"use client";

/**
 * The emergency switch, and the two quieter ways an account can go.
 *
 * One card because they are one decision made at three temperatures: something
 * is wrong right now, I want this to stop for a while, I want this gone. Putting
 * the last two at the bottom of a page about protecting the account is
 * deliberate - they are the end of that page and nothing is under them.
 *
 * Everything here costs the account's strongest proof rather than a confirmation
 * dialog. Lockdown especially: it is the one thing on this page somebody presses
 * when they already believe an attacker is holding a session, and "are you sure"
 * would be answered by that attacker just as easily.
 */

import { useState } from "react";
import * as core from "@polaris/core";
import { useRouter } from "next/navigation";
import { Loader2, ShieldAlert } from "lucide-react";
import type { StepUpProofInput } from "@polaris/core";
import { StepUpFields } from "@/components/step-up-fields";
import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { SettingLock } from "./setting-card";
import type { AccountStanding } from "@/lib/account-lifecycle";
import { closeAccountAction, liftLockdownAction, raiseLockdownAction } from "./lifecycle-actions";
import {
    Button,
    Card,
    CardBody,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Textarea
} from "@polaris/ui";

type Asking = "lockdown" | "lift" | "disabled" | "deleting";

/** What a lockdown does, one line each - the same four `LOCKDOWN_EFFECTS` in
 *  @polaris/core lists in English. */
const EFFECTS: readonly NamespaceKey<"accountSecurity">[] = [
    "lockdown.effects.protection",
    "lockdown.effects.signIn",
    "lockdown.effects.devices",
    "lockdown.effects.administrator"
];

export function LockdownCard({
    standing,
    lock
}: {
    standing: AccountStanding;
    /** A device the account has not settled with is refused everything here by
     *  the server as well; this only keeps it from being offered. */
    lock?: SettingLock;
}) {
    const router = useRouter();
    const t = useTranslations("accountSecurity");
    const [asking, setAsking] = useState<Asking | null>(null);
    const locked = Boolean(lock);

    return (
        <Card>
            <CardBody className="flex flex-col gap-4">
                <div className="flex items-start gap-3">
                    <ShieldAlert
                        className={standing.lockedDown ? "mt-0.5 size-4 shrink-0 text-danger" : "mt-0.5 size-4 shrink-0 text-muted-foreground"}
                    />
                    <div className="min-w-0 flex-1">
                        <h2 className="text-sm font-medium">
                            {standing.lockedDown ? t("lockdown.lockedTitle") : t("lockdown.title")}
                        </h2>
                        <p className="text-xs text-muted-foreground">
                            {standing.lockedDown ? t("lockdown.lockedDescription") : t("lockdown.description")}
                        </p>
                    </div>
                </div>

                <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
                    {EFFECTS.map((line) => (
                        <li key={line} className="flex gap-2">
                            <span aria-hidden>-</span>
                            <span>{t(line)}</span>
                        </li>
                    ))}
                </ul>

                {standing.lockedDown && standing.lockdownNote ? (
                    <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                        {t("lockdown.whatYouSaid", { note: standing.lockdownNote })}
                    </p>
                ) : null}

                <div className="flex justify-end">
                    {standing.lockedDown ? (
                        <Button variant="secondary" onClick={() => setAsking("lift")}>
                            {t("lockdown.lift")}
                        </Button>
                    ) : (
                        <Button variant="danger" disabled={locked} onClick={() => setAsking("lockdown")}>
                            {t("lockdown.lockItDown")}
                        </Button>
                    )}
                </div>

                <div className="flex flex-col gap-3 border-t border-border pt-4">
                    <div>
                        <h2 className="text-sm font-medium">{t("lockdown.leaving.title")}</h2>
                        <p className="text-xs text-muted-foreground">{t("lockdown.leaving.description")}</p>
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                        <Button variant="secondary" disabled={locked} onClick={() => setAsking("disabled")}>
                            {t("lockdown.leaving.switchOff")}
                        </Button>
                        <Button variant="danger" disabled={locked} onClick={() => setAsking("deleting")}>
                            {t("lockdown.leaving.delete")}
                        </Button>
                    </div>
                </div>

                <LockdownDialog
                    asking={asking}
                    onClose={() => setAsking(null)}
                    onDone={(closed) => {
                        setAsking(null);
                        // A closed account has no session left, so the browser is
                        // sent to the door rather than shown a page it can no
                        // longer read.
                        if (closed) router.push("/oauth/login?signedout=1");
                        else router.refresh();
                    }}
                />
            </CardBody>
        </Card>
    );
}

/** What each of the four is called, warned about, and confirmed with. */
function wording(
    t: NamespaceTranslator<"accountSecurity">,
    asking: Asking
): { title: string; description: string; confirm: string; danger: boolean; note: boolean } {
    switch (asking) {
        case "lockdown":
            return {
                title: t("lockdown.confirm.lockdown.title"),
                description: t("lockdown.confirm.lockdown.description"),
                confirm: t("lockdown.lockItDown"),
                danger: true,
                note: true
            };
        case "lift":
            return {
                title: t("lockdown.confirm.lift.title"),
                description: t("lockdown.confirm.lift.description"),
                confirm: t("lockdown.confirm.lift.confirm"),
                danger: false,
                note: false
            };
        case "disabled":
            return {
                title: t("lockdown.confirm.disabled.title"),
                description: t("lockdown.confirm.disabled.description"),
                confirm: t("lockdown.confirm.disabled.confirm"),
                danger: true,
                note: false
            };
        case "deleting":
            return {
                title: t("lockdown.confirm.deleting.title"),
                description: t("lockdown.confirm.deleting.description", { days: core.DELETION_GRACE_DAYS }),
                confirm: t("lockdown.confirm.deleting.confirm"),
                danger: true,
                note: false
            };
    }
}

function LockdownDialog({
    asking,
    onClose,
    onDone
}: {
    asking: Asking | null;
    onClose: () => void;
    /** True when the account is now closed, so the caller can send the browser
     *  away rather than refresh a page it cannot read. */
    onDone: (closed: boolean) => void;
}) {
    const t = useTranslations("accountSecurity");
    const tc = useTranslations("common");
    const [proof, setProof] = useState<StepUpProofInput | null>(null);
    const [note, setNote] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const open = asking !== null;
    const words = asking ? wording(t, asking) : null;

    async function confirm(): Promise<void> {
        if (!asking || !proof) return;
        setBusy(true);
        setError("");
        const result =
            asking === "lockdown"
                ? await raiseLockdownAction({ note, proof })
                : asking === "lift"
                  ? await liftLockdownAction({ proof })
                  : await closeAccountAction({ closure: asking, proof });
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        setNote("");
        setProof(null);
        onDone(asking === "disabled" || asking === "deleting");
    }

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (next) return;
                setProof(null);
                setError("");
                setNote("");
                onClose();
            }}
        >
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>{words?.title}</DialogTitle>
                    <DialogDescription>{words?.description}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    {words?.note ? (
                        <label className="flex flex-col gap-1 text-sm">
                            {t("lockdown.noteLabel")}
                            <Textarea
                                rows={3}
                                value={note}
                                maxLength={core.MAX_LOCKDOWN_NOTE}
                                placeholder={t("lockdown.notePlaceholder")}
                                onChange={(event) => setNote(event.target.value)}
                            />
                        </label>
                    ) : null}
                    {/* The same purpose the action checks against. A code is
                        minted per purpose, so a mismatch here is a code that
                        arrives and is then refused. */}
                    <StepUpFields
                        open={open}
                        purpose={asking === "lockdown" || asking === "lift" ? "lockdown" : "close-account"}
                        onChange={setProof}
                    />
                    {error ? (
                        <p role="alert" className="text-sm text-danger">
                            {error}
                        </p>
                    ) : null}
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        {tc("actions.cancel")}
                    </Button>
                    <Button
                        variant={words?.danger ? "danger" : "primary"}
                        disabled={busy || proof === null}
                        onClick={() => void confirm()}
                    >
                        {busy && <Loader2 className="size-4 animate-spin" />}
                        {words?.confirm}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
