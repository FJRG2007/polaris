"use client";

/**
 * The quick way to add a server: Polaris prints one command, the operator runs it
 * on the machine with sudo, and the machine registers itself.
 *
 * The panel is deliberately explicit about what the command does. It runs as root
 * on somebody's server, so "trust me" is not an acceptable interface: the account
 * it creates, and the separate opt-ins for container access and for root, are all
 * on screen with what each of them concedes before the command is generated.
 *
 * The same panel enrolls the machine Polaris itself runs on. Nothing about the
 * exchange differs - the box is reached over SSH like any other - so the only
 * difference is the kind, which is what tells the Servers app to fold the result
 * into the row it already shows for this machine.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Checkbox, Input, Select } from "@polaris/ui";
import type { ServerEnvironment } from "@polaris/core";
import { Check, Copy, Terminal, TriangleAlert } from "lucide-react";
import { ENVIRONMENT_CHOICES, ENVIRONMENT_META } from "./environment-meta";
import { cancelEnrollmentAction, enrollmentStatusAction, openEnrollmentAction } from "./actions";

/** How often the page asks whether the machine has called home. Frequent enough
 *  to feel immediate, slow enough that a forgotten open dialog is not a load. */
const POLL_MS = 2000;

const ENVIRONMENT_OPTIONS = [
    ...ENVIRONMENT_CHOICES.map((value) => ({ value, label: ENVIRONMENT_META[value].label })),
    { value: "unknown", label: "Not sure yet" }
];

interface Opened {
    id: string;
    command: string;
    expiresAt: string;
    insecureTransport: boolean;
    /** The same command aimed at this machine on the LAN, when there is one. */
    local?: { command: string; base: string; insecureTransport: boolean };
}

export function QuickEnroll({ onDone, kind = "server" }: { onDone: () => void; kind?: "server" | "local" }) {
    const router = useRouter();
    const isLocal = kind === "local";
    const [environment, setEnvironment] = useState<ServerEnvironment>("unknown");
    const [name, setName] = useState("");
    const [opened, setOpened] = useState<Opened | null>(null);
    const [pending, setPending] = useState(false);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [waitError, setWaitError] = useState<string | null>(null);
    // Whether the command the panel is still showing works. A machine that stops
    // before claiming - no SSH server running, Remote Login off - reports why and
    // spends nothing, so this is a state to recover from rather than the end of it.
    const [stillUsable, setStillUsable] = useState(false);
    /**
     * Whether the command shown is the LAN one.
     *
     * Off, because the configured domain is the right answer whenever the server
     * can reach the internet - it survives the machine moving and it has a
     * certificate. A box on an intranet with no way out cannot resolve it at all,
     * and until now the operator got a command that failed with nothing on screen
     * saying which address it had used.
     */
    const [overLan, setOverLan] = useState(false);

    // Watch the enrollment until the machine claims it. The dialog closing
    // unmounts this, which is what stops the poll.
    useEffect(() => {
        if (!opened) return;
        let live = true;
        const timer = setInterval(async () => {
            const status = await enrollmentStatusAction(opened.id);
            if (!live || !status) return;
            if (status.state === "claimed") {
                clearInterval(timer);
                router.refresh();
                onDone();
                return;
            }
            if (status.state === "failed") {
                setWaitError(status.error ?? "The machine could not be registered");
                setStillUsable(status.retryable);
                // Only a spent command is the end of the road. While the token is
                // still good the poll stays alive, so the operator who fixes the
                // machine and re-runs the same command watches this finish on its
                // own instead of being left in front of a stale error.
                if (!status.retryable) clearInterval(timer);
                return;
            }
            if (status.state === "expired") {
                clearInterval(timer);
                setStillUsable(false);
                // A machine that refused left its reason on the enrollment, and it
                // is still the true account of what happened - the command only
                // ran out afterwards. Saying it never ran would be the misreport
                // the refusal was reported to avoid, one lifetime later.
                setWaitError(
                    status.error
                        ? `${status.error} This command has since expired, so generate a new one.`
                        : "This command expired before the machine ran it"
                );
                return;
            }
            // The re-run got as far as claiming, so the refusal it recovered from
            // stops being the thing on screen.
            setWaitError(null);
            setStillUsable(false);
        }, POLL_MS);
        return () => {
            live = false;
            clearInterval(timer);
        };
    }, [opened, onDone, router]);

    async function generate() {
        setPending(true);
        setError(null);
        const result = await openEnrollmentAction({
            kind,
            name: name.trim() || (isLocal ? "This server" : "New server"),
            // This machine's location is already settled elsewhere (it is where
            // Polaris runs), so enrolling it never re-asks.
            environment: isLocal ? "unknown" : environment
        });
        setPending(false);
        if (result.error || !result.enrollment) {
            setError(result.error ?? "Could not start the enrollment");
            return;
        }
        setOpened(result.enrollment);
    }

    async function discard() {
        if (opened) await cancelEnrollmentAction(opened.id);
        setOpened(null);
        setWaitError(null);
        setStillUsable(false);
    }

    if (opened) {
        const local = opened.local;
        const showing = overLan && local ? local : opened;
        return (
            <div className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">
                    Run this on the server. It works once and expires{" "}
                    <RelativeExpiry at={opened.expiresAt} />.
                </p>

                <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3">
                    <Terminal className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <code className="flex-1 break-all font-mono text-xs leading-relaxed">
                        {showing.command}
                    </code>
                    <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Copy the command"
                        title="Copy the command"
                        onClick={() => {
                            void navigator.clipboard.writeText(showing.command);
                            setCopied(true);
                        }}
                    >
                        {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
                    </Button>
                </div>

                {local ? (
                    <label className="flex items-start gap-2 text-sm">
                        <Checkbox
                            checked={overLan}
                            aria-label="Point the command at the local address"
                            onChange={(event) => {
                                setOverLan(event.target.checked);
                                setCopied(false);
                            }}
                            className="mt-0.5"
                        />
                        <span className="text-muted-foreground">
                            This server cannot reach the internet. Point the command at{" "}
                            <code className="font-mono text-xs">{local.base}</code> instead, which only
                            works from the same network.
                        </span>
                    </label>
                ) : null}

                {showing.insecureTransport ? (
                    <Notice>
                        {overLan && local
                            ? "The local address has no certificate, so this command pipes an unencrypted download into a root shell. It stays on your own network, which is the trade being made."
                            : "Polaris is only reachable over plain HTTP here, so this command pipes an unencrypted download into a root shell. Set a domain with HTTPS under Admin > Domains before running it on anything you do not fully trust the network of."}
                    </Notice>
                ) : null}

                {waitError ? (
                    <div className="flex flex-col gap-1">
                        <p className="text-sm text-danger">{waitError}</p>
                        {stillUsable ? (
                            <p className="text-sm text-muted-foreground">
                                It was not used, so the command above still works. Fix that and run it
                                again before it expires - this picks it up on its own.
                            </p>
                        ) : null}
                    </div>
                ) : (
                    <p className="text-sm text-muted-foreground">Waiting for the server to check in...</p>
                )}

                <div className="mt-1 flex justify-end gap-2">
                    <Button variant="ghost" onClick={() => void discard()}>
                        {waitError && !stillUsable ? "Start over" : "Cancel this command"}
                    </Button>
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
                {isLocal ? (
                    <>
                        Polaris runs in a container, so it reaches this machine through its container
                        engine and nothing else - which is why it has no shell here. Run this command on
                        the machine itself and it joins like any other server: a dedicated{" "}
                        <code className="font-mono text-xs">polaris</code> login with no password,
                        authorized for one key Polaris keeps.
                    </>
                ) : (
                    <>
                        Polaris generates a command you run on the server. It creates a dedicated{" "}
                        <code className="font-mono text-xs">polaris</code> login with no password,
                        authorizes one key Polaris keeps, and registers the machine. No credential of
                        yours is typed anywhere.
                    </>
                )}
            </p>

            {isLocal ? null : (
                <label className="flex flex-col gap-1 text-sm">
                    Name (optional)
                    <Input
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        placeholder="Its hostname is used when you leave this empty"
                    />
                </label>
            )}

            {isLocal ? null : (
                <label className="flex flex-col gap-1 text-sm">
                    Where it lives
                    <Select
                        value={environment}
                        onValueChange={(value) => setEnvironment(value as ServerEnvironment)}
                        options={ENVIRONMENT_OPTIONS}
                    />
                    <span className="text-xs text-muted-foreground">{ENVIRONMENT_META[environment].routing}</span>
                </label>
            )}

            <p className="text-xs text-muted-foreground">
                The command adds a dedicated login, lets it manage containers and gives it
                password-less sudo, which is what deploying, CI jobs and the file browser need. Undo
                it later by deleting the login and /etc/sudoers.d/polaris.
            </p>

            {error ? <p className="text-sm text-danger">{error}</p> : null}

            <div className="mt-1 flex justify-end">
                <Button onClick={() => void generate()} disabled={pending}>
                    {pending ? "Generating..." : "Generate the command"}
                </Button>
            </div>
        </div>
    );
}

function Notice({ children }: { children: React.ReactNode }) {
    return (
        <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-muted-foreground">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
            {children}
        </p>
    );
}

/** Minutes left on the command, recomputed as it counts down so a dialog left
 *  open does not keep claiming the command is still good. */
function RelativeExpiry({ at }: { at: string }) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 30_000);
        return () => clearInterval(timer);
    }, []);
    const minutes = Math.max(0, Math.round((new Date(at).getTime() - now) / 60_000));
    return <span>{minutes === 0 ? "in under a minute" : `in ${minutes} min`}</span>;
}
