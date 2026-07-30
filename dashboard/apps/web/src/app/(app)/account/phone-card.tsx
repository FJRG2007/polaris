"use client";

/**
 * The account's phone number: a profile detail that doubles as the address a
 * second-factor code is sent to.
 *
 * It is written down first and confirmed second, because a mistyped digit would
 * otherwise send codes to a stranger for as long as nobody noticed. The
 * confirmation arrives the same way the codes themselves will - through one of
 * the user's own WhatsApp channels - so a number that confirms is a number that
 * can be reached, not just one that looks right.
 */

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Phone } from "lucide-react";
import { otpCodeField, phoneField } from "@polaris/core";
import type { UserPhoneView } from "@polaris/auth";
import {
    Badge,
    Button,
    Card,
    CardBody,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Input
} from "@polaris/ui";
import {
    removePhoneAction,
    sendPhoneCodeAction,
    setPhoneAction,
    verifyPhoneAction
} from "./security/two-factor-actions";
import { Feedback } from "./security/setting-card";

export function PhoneCard({ phone, canSend }: { phone: UserPhoneView | null; canSend: boolean }) {
    const router = useRouter();
    const [dialog, setDialog] = useState<"set" | "remove" | null>(null);
    const [code, setCode] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    async function run(action: () => Promise<{ error?: string }>, ok?: string) {
        setBusy(true);
        setError(null);
        setNotice(null);
        const result = await action();
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return false;
        }
        if (ok) setNotice(ok);
        router.refresh();
        return true;
    }

    async function verify(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const parsed = otpCodeField.safeParse(code);
        if (!parsed.success) {
            setError(parsed.error.issues[0]?.message ?? "Enter the 6-digit code.");
            return;
        }
        if (await run(() => verifyPhoneAction(parsed.data))) setCode("");
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <h2 className="text-sm font-medium">Phone number</h2>
                        <p className="text-xs text-muted-foreground">
                            Confirmed through one of your own WhatsApp channels, which is also what
                            carries a sign-in code when you use one.
                        </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        {phone ? (
                            <Button variant="ghost" size="sm" onClick={() => setDialog("remove")}>
                                Remove
                            </Button>
                        ) : null}
                        <Button onClick={() => setDialog("set")}>{phone ? "Change" : "Add"}</Button>
                    </div>
                </div>

                {phone ? (
                    <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2">
                        <Phone className="size-4 shrink-0 text-muted-foreground" />
                        <span className="truncate text-sm">{phone.phone}</span>
                        {phone.verified ? (
                            <Badge className="border-success/40 text-success">Confirmed</Badge>
                        ) : (
                            <Badge className="border-warning/40 text-warning">Unconfirmed</Badge>
                        )}
                    </div>
                ) : null}

                {phone && !phone.verified ? (
                    <form onSubmit={verify} className="flex flex-col gap-2">
                        <div className="flex items-start gap-2">
                            <Input
                                value={code}
                                inputMode="numeric"
                                maxLength={6}
                                placeholder="000000"
                                autoComplete="one-time-code"
                                aria-label="Confirmation code"
                                onChange={(event) => setCode(event.target.value)}
                            />
                            <Button type="submit" disabled={busy || code.length === 0}>
                                Confirm
                            </Button>
                            <Button
                                type="button"
                                variant="outline"
                                disabled={busy || !canSend}
                                title={
                                    canSend
                                        ? undefined
                                        : "Connect one of your WhatsApp channels first - the code is sent through it."
                                }
                                onClick={() => void run(sendPhoneCodeAction, "Code sent on WhatsApp.")}
                            >
                                Send code
                            </Button>
                        </div>
                    </form>
                ) : null}

                <Feedback error={error} ok={notice} />
            </CardBody>

            <SetPhoneDialog
                open={dialog === "set"}
                current={phone?.phone ?? ""}
                onOpenChange={(open) => !open && setDialog(null)}
                onDone={() => {
                    setDialog(null);
                    router.refresh();
                }}
            />
            <RemovePhoneDialog
                open={dialog === "remove"}
                onOpenChange={(open) => !open && setDialog(null)}
                onDone={() => {
                    setDialog(null);
                    router.refresh();
                }}
            />
        </Card>
    );
}

/** Writing the number is a way into the account, so it re-asks for the password. */
function SetPhoneDialog({
    open,
    current,
    onOpenChange,
    onDone
}: {
    open: boolean;
    current: string;
    onOpenChange: (open: boolean) => void;
    onDone: () => void;
}) {
    const [phone, setPhone] = useState(current);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const candidate = phoneField.safeParse(phone);

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!candidate.success) {
            setError(candidate.error.issues[0]?.message ?? "Check the number.");
            return;
        }
        const password = String(new FormData(event.currentTarget).get("password") ?? "");
        setBusy(true);
        setError(null);
        const result = await setPhoneAction({ phone: candidate.data, password });
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        onDone();
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>{current ? "Change your number" : "Add a phone number"}</DialogTitle>
                    <DialogDescription>
                        It starts unconfirmed. Confirm it before it can carry a sign-in code.
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={onSubmit} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        Phone number
                        <Input
                            value={phone}
                            placeholder="+34600111222"
                            autoComplete="tel"
                            onChange={(event) => setPhone(event.target.value)}
                        />
                        {phone && !candidate.success ? (
                            <span className="text-xs text-danger">
                                {candidate.error.issues[0]?.message}
                            </span>
                        ) : null}
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        Current password
                        <Input name="password" type="password" required autoComplete="current-password" />
                    </label>
                    <Feedback error={error} />
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={busy || !candidate.success}>
                            {busy ? "Saving..." : "Save"}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function RemovePhoneDialog({
    open,
    onOpenChange,
    onDone
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onDone: () => void;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const password = String(new FormData(event.currentTarget).get("password") ?? "");
        setBusy(true);
        setError(null);
        const result = await removePhoneAction(password);
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        onDone();
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>Remove your number</DialogTitle>
                    <DialogDescription>
                        Confirm your password. WhatsApp stops being one of your sign-in options.
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={onSubmit} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        Current password
                        <Input name="password" type="password" required autoComplete="current-password" />
                    </label>
                    <Feedback error={error} />
                    <div className="flex justify-end gap-2">
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" variant="danger" disabled={busy}>
                            {busy ? "Removing..." : "Remove"}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
