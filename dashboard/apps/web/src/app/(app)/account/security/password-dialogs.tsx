"use client";

/**
 * The two ways to set a new password: knowing the current one, and not knowing
 * it. The second path exists because a signed-in user can still have forgotten
 * their password, and the alternatives are worse - staying signed in forever, or
 * an email reset Polaris cannot send. Identity is proven instead by the recovery
 * questions or by a live authenticator code, both verified server-side.
 *
 * Either path ends every other session, since a password change is also how a
 * user evicts someone else.
 */

import { useState, type FormEvent } from "react";
import { SECURITY_QUESTION_COUNT } from "@polaris/core";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input } from "@polaris/ui";
import { changePasswordAction, recoverPasswordAction } from "./actions";
import { Feedback } from "./setting-card";

export function ChangePasswordDialog({
    open,
    onOpenChange
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<string | null>(null);

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const next = String(form.get("newPassword") ?? "");
        if (next !== String(form.get("confirmPassword") ?? "")) {
            setError("The new passwords do not match.");
            return;
        }
        setBusy(true);
        setError(null);
        const result = await changePasswordAction(String(form.get("currentPassword") ?? ""), next);
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        setDone("Password changed. Every other session was signed out.");
    }

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                onOpenChange(next);
                if (!next) {
                    setError(null);
                    setDone(null);
                }
            }}
        >
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Change password</DialogTitle>
                    <DialogDescription>Use at least 10 characters.</DialogDescription>
                </DialogHeader>
                {done ? (
                    <div className="flex flex-col gap-3">
                        <Feedback ok={done} />
                        <Button onClick={() => onOpenChange(false)} className="ml-auto">
                            Done
                        </Button>
                    </div>
                ) : (
                    <form onSubmit={onSubmit} className="flex flex-col gap-3">
                        <label className="flex flex-col gap-1 text-sm">
                            Current password
                            <Input name="currentPassword" type="password" required autoComplete="current-password" />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            New password
                            <Input name="newPassword" type="password" required autoComplete="new-password" />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            Confirm new password
                            <Input name="confirmPassword" type="password" required autoComplete="new-password" />
                        </label>
                        <Feedback error={error} />
                        <div className="flex justify-end gap-2">
                            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                                Cancel
                            </Button>
                            <Button type="submit" disabled={busy}>
                                {busy ? "Changing..." : "Change password"}
                            </Button>
                        </div>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
}

export function RecoverPasswordDialog({
    open,
    onOpenChange,
    questions,
    canUseAuthenticator
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    questions: string[];
    canUseAuthenticator: boolean;
}) {
    const hasQuestions = questions.length === SECURITY_QUESTION_COUNT;
    const [method, setMethod] = useState<"questions" | "totp">(hasQuestions ? "questions" : "totp");
    const [answers, setAnswers] = useState<string[]>(() => questions.map(() => ""));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<string | null>(null);

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const next = String(form.get("newPassword") ?? "");
        if (next !== String(form.get("confirmPassword") ?? "")) {
            setError("The new passwords do not match.");
            return;
        }
        setBusy(true);
        setError(null);
        const result = await recoverPasswordAction({
            newPassword: next,
            answers: method === "questions" ? answers : [],
            totpCode: method === "totp" ? String(form.get("totpCode") ?? "") : undefined
        });
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        setDone("Password set. Every other session was signed out.");
    }

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                onOpenChange(next);
                if (!next) {
                    setError(null);
                    setDone(null);
                    setAnswers(questions.map(() => ""));
                }
            }}
        >
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>Set a new password</DialogTitle>
                    <DialogDescription>
                        Prove it is you without your current password, then choose a new one.
                    </DialogDescription>
                </DialogHeader>

                {!hasQuestions && !canUseAuthenticator ? (
                    <p className="text-sm text-muted-foreground">
                        Set security questions or an authenticator first - without one of them there is no way to
                        verify you here.
                    </p>
                ) : done ? (
                    <div className="flex flex-col gap-3">
                        <Feedback ok={done} />
                        <Button onClick={() => onOpenChange(false)} className="ml-auto">
                            Done
                        </Button>
                    </div>
                ) : (
                    <form onSubmit={onSubmit} className="flex flex-col gap-3">
                        {hasQuestions && canUseAuthenticator ? (
                            <div className="flex gap-2">
                                <Button
                                    type="button"
                                    variant={method === "questions" ? "primary" : "ghost"}
                                    onClick={() => setMethod("questions")}
                                >
                                    Security questions
                                </Button>
                                <Button
                                    type="button"
                                    variant={method === "totp" ? "primary" : "ghost"}
                                    onClick={() => setMethod("totp")}
                                >
                                    Authenticator
                                </Button>
                            </div>
                        ) : null}

                        {method === "questions" && hasQuestions
                            ? questions.map((question, index) => (
                                  <label key={question} className="flex flex-col gap-1 text-sm">
                                      {question}
                                      <Input
                                          value={answers[index] ?? ""}
                                          autoComplete="off"
                                          required
                                          onChange={(event) =>
                                              setAnswers((prev) =>
                                                  prev.map((value, position) =>
                                                      position === index ? event.target.value : value
                                                  )
                                              )
                                          }
                                      />
                                  </label>
                              ))
                            : null}

                        {method === "totp" && canUseAuthenticator ? (
                            <label className="flex flex-col gap-1 text-sm">
                                Authenticator code
                                <Input
                                    name="totpCode"
                                    inputMode="numeric"
                                    maxLength={6}
                                    placeholder="000000"
                                    autoComplete="one-time-code"
                                    required
                                />
                            </label>
                        ) : null}

                        <label className="flex flex-col gap-1 text-sm">
                            New password
                            <Input name="newPassword" type="password" required autoComplete="new-password" />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            Confirm new password
                            <Input name="confirmPassword" type="password" required autoComplete="new-password" />
                        </label>
                        <Feedback error={error} />
                        <div className="flex justify-end gap-2">
                            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                                Cancel
                            </Button>
                            <Button type="submit" disabled={busy}>
                                {busy ? "Saving..." : "Set password"}
                            </Button>
                        </div>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
}
