"use client";

/**
 * Asking to get back into an account, and finishing the job once somebody has
 * said yes.
 *
 * The whole state of a request is the ticket, so the page keeps it in the URL:
 * closing the tab and coming back to the link picks up exactly where it left off,
 * which matters because a decision can take as long as an administrator takes.
 */

import Link from "next/link";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { passwordIsBreached } from "@/lib/pwned-passwords";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button, Card, CardBody, CardHeader, CardTitle, Input, PolarisMark } from "@polaris/ui";
import { BREACHED_PASSWORD_MESSAGE, SECURITY_QUESTION_COUNT, type AccountRecoveryStatus } from "@polaris/core";
import {
    completeRecoveryAction,
    lookupRecoveryAction,
    recoveryStatusAction,
    requestRecoveryAction
} from "./actions";

/**
 * How often the waiting screen asks whether a decision has been made.
 *
 * Fast while somebody is sitting in front of it, because the two people in this
 * are usually in the same room or on the same call - an administrator says "done"
 * and the person is looking at a screen that has not moved. Slow once the tab has
 * been open long enough that nobody is watching it, and stopped entirely while it
 * is in the background: a page left open for a day must not spend that day asking.
 * Coming back to the tab checks straight away, so the slow tier is never the delay
 * somebody actually experiences.
 */
const POLL_MS = 3000;
const IDLE_POLL_MS = 30_000;

/** How long the screen is treated as watched. */
const ATTENTIVE_MS = 10 * 60 * 1000;

/** Long enough that the corpus is not asked about every keystroke. */
const BREACH_DEBOUNCE_MS = 500;

/** The shortest password worth asking about; the form refuses anything under 10
 *  on its own. */
const MIN_PASSWORD = 10;

type Step = "identify" | "prove" | "waiting" | "reset" | "done";

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <main className="grid min-h-screen place-items-center p-4">
            <Card className="w-full max-w-sm">
                <CardHeader className="items-center">
                    <PolarisMark className="mb-1" />
                    <CardTitle>{title}</CardTitle>
                </CardHeader>
                <CardBody>{children}</CardBody>
            </Card>
        </main>
    );
}

export function RecoverForm({ initialTicket }: { initialTicket: string }) {
    const router = useRouter();
    const [step, setStep] = useState<Step>(initialTicket ? "waiting" : "identify");
    const [identifier, setIdentifier] = useState("");
    const [questions, setQuestions] = useState<string[]>([]);
    const [answers, setAnswers] = useState<string[]>([]);
    const [ticket, setTicket] = useState(initialTicket);
    const [status, setStatus] = useState<AccountRecoveryStatus>("pending");
    const [password, setPassword] = useState("");
    const [breached, setBreached] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    /** Move the ticket into the URL so the tab can be closed without losing it. */
    const rememberTicket = useCallback((value: string) => {
        setTicket(value);
        window.history.replaceState(null, "", `/oauth/recover?ticket=${encodeURIComponent(value)}`);
    }, []);

    // Ask the breach corpus as the password is typed, so the refusal arrives
    // before the submit rather than after it. The password never leaves the
    // browser - only the first five characters of its hash do - and a lookup that
    // cannot be made says nothing, because the server checks again anyway.
    useEffect(() => {
        if (step !== "reset" || password.length < MIN_PASSWORD) {
            setBreached(false);
            return;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => {
            void passwordIsBreached(password, controller.signal).then((found) => {
                if (!controller.signal.aborted) setBreached(found);
            });
        }, BREACH_DEBOUNCE_MS);
        return () => {
            controller.abort();
            clearTimeout(timer);
        };
    }, [step, password]);

    // Watch for the decision. An approved request opens the password form itself,
    // so someone who left the page open is not left refreshing it, and a link that
    // was already spent says so rather than pretending to be still waiting.
    useEffect(() => {
        if (step !== "waiting" || !ticket) return;
        let current = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const opened = Date.now();

        const check = async () => {
            const next = await recoveryStatusAction(ticket);
            if (!current) return;
            setStatus(next);
            if (next === "approved") setStep("reset");
            if (next === "used") setStep("done");
        };

        // A chain of timeouts rather than an interval: the wait changes as the
        // page ages, and a hidden tab schedules nothing at all until it is
        // looked at again.
        const ask = async () => {
            await check();
            if (!current || document.visibilityState === "hidden") return;
            const wait = Date.now() - opened < ATTENTIVE_MS ? POLL_MS : IDLE_POLL_MS;
            timer = setTimeout(() => void ask(), wait);
        };

        const onVisible = () => {
            if (!current || document.visibilityState !== "visible") return;
            clearTimeout(timer);
            void ask();
        };

        void ask();
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            current = false;
            clearTimeout(timer);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [step, ticket]);

    async function onIdentify(event: FormEvent) {
        event.preventDefault();
        if (!identifier.trim()) {
            setError("Enter your email or username.");
            return;
        }
        setPending(true);
        setError(null);
        const result = await lookupRecoveryAction({ identifier });
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        setQuestions(result.questions);
        setAnswers(Array.from({ length: result.questions.length }, () => ""));
        setStep("prove");
    }

    async function onRequest(event: FormEvent) {
        event.preventDefault();
        if (questions.length > 0 && answers.some((answer) => answer.trim().length < 2)) {
            setError("Answer every question.");
            return;
        }
        setPending(true);
        setError(null);
        const result = await requestRecoveryAction({ identifier, answers });
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        rememberTicket(result.ticket);
        setStatus("pending");
        setStep("waiting");
    }

    async function onReset(event: FormEvent) {
        event.preventDefault();
        if (password.length < MIN_PASSWORD) {
            setError(`Use at least ${MIN_PASSWORD} characters.`);
            return;
        }
        if (breached) {
            setError(BREACHED_PASSWORD_MESSAGE);
            return;
        }
        setPending(true);
        setError(null);
        const result = await completeRecoveryAction({ ticket, newPassword: password });
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        setPassword("");
        setStep("done");
    }

    function startOver() {
        setStep("identify");
        setQuestions([]);
        setAnswers([]);
        setTicket("");
        setError(null);
        window.history.replaceState(null, "", "/oauth/recover");
    }

    if (step === "identify") {
        return (
            <Shell title="Recover your account">
                <p className="text-sm text-muted-foreground">
                    If you have lost your password and every other way in, ask whoever runs this
                    Polaris to let you back on.
                </p>
                <form onSubmit={onIdentify} noValidate className="mt-3 flex flex-col gap-3">
                    <Input
                        placeholder="Email or username"
                        autoComplete="username"
                        value={identifier}
                        onChange={(event) => setIdentifier(event.target.value)}
                    />
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <Button type="submit" disabled={pending}>
                        {pending ? "Checking..." : "Continue"}
                    </Button>
                    <Link
                        href="/oauth/login"
                        className="text-center text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                    >
                        Back to sign in
                    </Link>
                </form>
            </Shell>
        );
    }

    if (step === "prove") {
        return (
            <Shell title="Recover your account">
                {questions.length === SECURITY_QUESTION_COUNT ? (
                    <p className="text-sm text-muted-foreground">
                        Answer your security questions. They go with the request, so whoever decides
                        it can see you got them right.
                    </p>
                ) : (
                    <p className="text-sm text-muted-foreground">
                        There are no security questions on this account, so nothing here can be
                        checked automatically. Whoever runs this Polaris will have to recognise you
                        another way before approving it.
                    </p>
                )}
                <form onSubmit={onRequest} noValidate className="mt-3 flex flex-col gap-3">
                    {questions.map((question, index) => (
                        <div key={question} className="flex flex-col gap-1">
                            <label className="text-sm">{question}</label>
                            <Input
                                autoComplete="off"
                                value={answers[index] ?? ""}
                                onChange={(event) =>
                                    setAnswers((previous) =>
                                        previous.map((answer, at) => (at === index ? event.target.value : answer))
                                    )
                                }
                            />
                        </div>
                    ))}
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <Button type="submit" disabled={pending}>
                        {pending ? "Sending..." : "Send request"}
                    </Button>
                    <Button type="button" variant="ghost" onClick={startOver}>
                        Use a different account
                    </Button>
                </form>
            </Shell>
        );
    }

    if (step === "waiting") {
        const settled = status === "denied" || status === "expired";
        return (
            <Shell title="Waiting for approval">
                {settled ? (
                    <>
                        <p className="text-sm text-muted-foreground">
                            {status === "denied"
                                ? "That request was turned down. Speak to whoever runs this Polaris."
                                : "That request expired before it was decided."}
                        </p>
                        <Button className="mt-3 w-full" onClick={startOver}>
                            Start again
                        </Button>
                    </>
                ) : (
                    <>
                        <p className="text-sm text-muted-foreground">
                            If that account exists, the administrators have been asked to approve it.
                            Leave this page open - it turns into the password form the moment one of
                            them says yes.
                        </p>
                        {/* The ticket used to be printed here as a path to copy,
                            which was a credential on a screen anybody walking past
                            could read and told nobody anything the address bar was
                            not already saying. It is in the URL of this very page,
                            so the way back is to bookmark it or leave it open. */}
                        <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                            Waiting for a decision. Nothing here needs doing.
                        </p>
                        <p className="mt-3 text-xs text-muted-foreground">
                            If you close this tab, the address of this page is the way back to the
                            request - bookmark it. It expires in 24 hours either way.
                        </p>
                    </>
                )}
                <Link
                    href="/oauth/login"
                    className="mt-4 block text-center text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                    Back to sign in
                </Link>
            </Shell>
        );
    }

    if (step === "reset") {
        return (
            <Shell title="Set a new password">
                <p className="text-sm text-muted-foreground">
                    Your request was approved. Choosing a password here signs out everything else on
                    the account.
                </p>
                <form onSubmit={onReset} noValidate className="mt-3 flex flex-col gap-3">
                    {/* A password manager needs to know which account it is saving this
                        under, and there is nothing else on the form to tell it. Absent when
                        the page was opened straight from the ticket link, which is the one
                        case where the browser knows the account and this page does not. */}
                    {identifier ? (
                        <input type="text" autoComplete="username" value={identifier} readOnly hidden />
                    ) : null}
                    {/* enigma:allow-identity-password - this page is unauthenticated and is
                        deliberately never told whose account it is recovering, so there is no
                        identity here to compare against. The refusal runs server-side in
                        account-recovery-service, where the account is known. */}
                    <Input
                        type="password"
                        placeholder={`${MIN_PASSWORD}+ characters`}
                        autoComplete="new-password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        aria-invalid={breached}
                    />
                    {breached ? <p className="text-sm text-danger">{BREACHED_PASSWORD_MESSAGE}</p> : null}
                    {error ? <p className="text-sm text-danger">{error}</p> : null}
                    <Button type="submit" disabled={pending || breached}>
                        {pending ? "Saving..." : "Set password"}
                    </Button>
                </form>
            </Shell>
        );
    }

    return (
        <Shell title="You are back in">
            <p className="text-sm text-muted-foreground">
                Your password is set. Sign in with it to finish.
            </p>
            <Button className="mt-3 w-full" onClick={() => router.push("/oauth/login")}>
                Go to sign in
            </Button>
        </Shell>
    );
}
