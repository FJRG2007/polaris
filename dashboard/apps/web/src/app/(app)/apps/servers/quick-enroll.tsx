"use client";

/**
 * The quick way to add a server: Polaris prints one command, the operator runs it
 * on the machine with sudo, and the machine registers itself.
 *
 * The panel is deliberately explicit about what the command does. It runs as root
 * on somebody's server, so "trust me" is not an acceptable interface: the account
 * it creates, the fact that it grants no sudo, and the separate opt-in for
 * container access are all on screen before the command is generated.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { ServerEnvironment } from "@polaris/core";
import { Button, Checkbox, Input, Select } from "@polaris/ui";
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
}

export function QuickEnroll({ onDone }: { onDone: () => void }) {
    const router = useRouter();
    const [environment, setEnvironment] = useState<ServerEnvironment>("unknown");
    const [grantDocker, setGrantDocker] = useState(false);
    const [name, setName] = useState("");
    const [opened, setOpened] = useState<Opened | null>(null);
    const [pending, setPending] = useState(false);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [waitError, setWaitError] = useState<string | null>(null);

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
                clearInterval(timer);
                setWaitError(status.error ?? "The machine could not be registered");
                return;
            }
            if (status.state === "expired") {
                clearInterval(timer);
                setWaitError("This command expired before the machine ran it");
            }
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
            kind: "server",
            name: name.trim() || "New server",
            environment,
            grantDocker
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
    }

    if (opened) {
        return (
            <div className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">
                    Run this on the server. It works once and expires{" "}
                    <RelativeExpiry at={opened.expiresAt} />.
                </p>

                <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3">
                    <Terminal className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <code className="flex-1 break-all font-mono text-xs leading-relaxed">
                        {opened.command}
                    </code>
                    <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Copy the command"
                        title="Copy the command"
                        onClick={() => {
                            void navigator.clipboard.writeText(opened.command);
                            setCopied(true);
                        }}
                    >
                        {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
                    </Button>
                </div>

                {opened.insecureTransport ? (
                    <Notice>
                        Polaris is only reachable over plain HTTP here, so this command pipes an
                        unencrypted download into a root shell. Set a domain with HTTPS under Admin &gt;
                        Domains before running it on anything you do not fully trust the network of.
                    </Notice>
                ) : null}

                {waitError ? (
                    <p className="text-sm text-danger">{waitError}</p>
                ) : (
                    <p className="text-sm text-muted-foreground">Waiting for the server to check in...</p>
                )}

                <div className="mt-1 flex justify-end gap-2">
                    <Button variant="ghost" onClick={() => void discard()}>
                        {waitError ? "Start over" : "Cancel this command"}
                    </Button>
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
                Polaris generates a command you run on the server. It creates a dedicated{" "}
                <code className="font-mono text-xs">polaris</code> login with no password and no sudo,
                authorizes one key Polaris keeps, and registers the machine. No credential of yours is
                typed anywhere.
            </p>

            <label className="flex flex-col gap-1 text-sm">
                Name (optional)
                <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Its hostname is used when you leave this empty"
                />
            </label>

            <label className="flex flex-col gap-1 text-sm">
                Where it lives
                <Select
                    value={environment}
                    onValueChange={(value) => setEnvironment(value as ServerEnvironment)}
                    options={ENVIRONMENT_OPTIONS}
                />
                <span className="text-xs text-muted-foreground">{ENVIRONMENT_META[environment].routing}</span>
            </label>

            <label className="flex items-start gap-2 text-sm">
                <Checkbox
                    checked={grantDocker}
                    onChange={(event) => setGrantDocker(event.target.checked)}
                />
                <span>
                    Let Polaris manage containers on this server
                    <span className="block text-xs text-muted-foreground">
                        Adds the login to the docker group, which on most systems is the same as giving
                        it root. Leave it off unless you plan to deploy there.
                    </span>
                </span>
            </label>

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
