"use client";

/**
 * Create a runner pool.
 *
 * The form asks the machine what it can do the moment a server is picked, rather
 * than offering every isolation choice and letting the server reject one at the
 * end. That is the difference between "containers are unavailable on this machine,
 * here is why" and a save button that fails after the operator has filled in
 * everything else.
 *
 * It validates against the same schema the action does, so a value the form
 * accepts is never one the server refuses on shape.
 */

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createRunnerPoolAction, probeRunnerHostAction } from "./actions";
import { createRunnerPoolSchema, DEFAULT_RUNNER_LABELS, MAX_RUNNER_CONCURRENCY, type RunnerIsolation, type RunnerScope } from "@polaris/core";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
    Input,
    Select
} from "@polaris/ui";

interface ServerOption {
    id: string;
    name: string;
}

interface Readiness {
    platform: string;
    arch: string;
    containerEngine: boolean;
    unsupported: string | null;
}

const SCOPE_OPTIONS = [
    { value: "repo", label: "One repository" },
    { value: "org", label: "A whole organization" }
];

export function PoolDialog({ servers, disabled }: { servers: ServerOption[]; disabled: boolean }) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [name, setName] = useState("");
    const [hostId, setHostId] = useState("");
    const [scope, setScope] = useState<RunnerScope>("repo");
    const [targetOwner, setTargetOwner] = useState("");
    const [targetRepo, setTargetRepo] = useState("");
    const [labels, setLabels] = useState(DEFAULT_RUNNER_LABELS.join(", "));
    const [maxConcurrent, setMaxConcurrent] = useState("1");
    const [isolation, setIsolation] = useState<RunnerIsolation>("container");
    const [readiness, setReadiness] = useState<Readiness | null>(null);
    const [probing, setProbing] = useState(false);
    const [probeError, setProbeError] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    const draft = {
        hostId,
        name,
        scope,
        targetOwner,
        targetRepo: scope === "repo" ? targetRepo : undefined,
        labels: labels.split(","),
        maxConcurrent,
        isolation
    };
    const checked = createRunnerPoolSchema.safeParse(draft);
    const issue = (field: string): string | null =>
        checked.success ? null : (checked.error.issues.find((entry) => entry.path[0] === field)?.message ?? null);

    // Ask the machine what it can offer as soon as one is picked. A stale answer is
    // worse than none, so it is cleared while the next one is being fetched.
    useEffect(() => {
        if (!hostId) return;
        let live = true;
        setProbing(true);
        setReadiness(null);
        setProbeError(null);
        void probeRunnerHostAction(hostId).then((result) => {
            if (!live) return;
            setProbing(false);
            if (result.error || !result.readiness) {
                setProbeError(result.error ?? "Could not reach that server");
                return;
            }
            setReadiness(result.readiness);
            if (!result.readiness.containerEngine) setIsolation("workspace");
        });
        return () => {
            live = false;
        };
    }, [hostId]);

    const containersAvailable = readiness !== null && readiness.platform === "linux" && readiness.containerEngine;
    const isolationOptions = [
        { value: "container", label: "Its own container", disabled: !containersAvailable },
        { value: "workspace", label: "A clean directory on the machine" }
    ];

    async function submit() {
        if (!checked.success) return;
        setPending(true);
        setError(null);
        const result = await createRunnerPoolAction(draft);
        setPending(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        setOpen(false);
        router.refresh();
    }

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (next) {
                    setName("");
                    setHostId("");
                    setScope("repo");
                    setTargetOwner("");
                    setTargetRepo("");
                    setLabels(DEFAULT_RUNNER_LABELS.join(", "));
                    setMaxConcurrent("1");
                    setIsolation("container");
                    setReadiness(null);
                    setProbeError(null);
                    setError(null);
                }
                setOpen(next);
            }}
        >
            <DialogTrigger asChild>
                <Button size="sm" variant="secondary" disabled={disabled}>
                    <Plus className="size-4" /> Add a pool
                </Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>New runner pool</DialogTitle>
                    <DialogDescription>
                        Polaris keeps runners waiting on one of your servers. Workflows reach them with
                        <code className="mx-1 font-mono text-xs">runs-on</code>.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-3">
                    <Field label="Name" error={name ? issue("name") : null}>
                        <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Build" />
                    </Field>

                    <Field label="Server" error={probeError}>
                        <Select
                            value={hostId}
                            onValueChange={setHostId}
                            placeholder="Pick a server"
                            options={servers.map((server) => ({ value: server.id, label: server.name }))}
                        />
                        <MachineNote probing={probing} readiness={readiness} />
                    </Field>

                    <Field label="Runners serve">
                        <Select
                            value={scope}
                            onValueChange={(value) => setScope(value as RunnerScope)}
                            options={SCOPE_OPTIONS}
                        />
                    </Field>

                    <div className="flex gap-2">
                        <Field
                            label={scope === "org" ? "Organization" : "Account"}
                            error={targetOwner ? issue("targetOwner") : null}
                            className="flex-1"
                        >
                            <Input
                                value={targetOwner}
                                onChange={(event) => setTargetOwner(event.target.value)}
                                placeholder="acme"
                                autoCapitalize="none"
                                autoCorrect="off"
                                spellCheck={false}
                            />
                        </Field>
                        {scope === "repo" ? (
                            <Field label="Repository" error={targetRepo ? issue("targetRepo") : null} className="flex-1">
                                <Input
                                    value={targetRepo}
                                    onChange={(event) => setTargetRepo(event.target.value)}
                                    placeholder="website"
                                    autoCapitalize="none"
                                    autoCorrect="off"
                                    spellCheck={false}
                                />
                            </Field>
                        ) : null}
                    </div>

                    <Field label="Labels" error={issue("labels")}>
                        <Input value={labels} onChange={(event) => setLabels(event.target.value)} />
                        <Hint>
                            Comma separated. A workflow lands here when its{" "}
                            <code className="font-mono text-xs">runs-on</code> asks for these.
                        </Hint>
                    </Field>

                    <div className="flex gap-2">
                        <Field label="Jobs at once" error={issue("maxConcurrent")} className="w-32">
                            <Input
                                type="number"
                                min={1}
                                max={MAX_RUNNER_CONCURRENCY}
                                inputMode="numeric"
                                value={maxConcurrent}
                                onChange={(event) => setMaxConcurrent(event.target.value)}
                            />
                        </Field>
                        <Field label="Each job runs in" className="flex-1">
                            <Select
                                value={isolation}
                                onValueChange={(value) => setIsolation(value as RunnerIsolation)}
                                options={isolationOptions}
                                disabled={readiness === null}
                            />
                            <IsolationNote isolation={isolation} available={containersAvailable} />
                        </Field>
                    </div>

                    {error ? <p className="text-sm text-danger">{error}</p> : null}

                    <div className="mt-1 flex justify-end">
                        <Button onClick={() => void submit()} disabled={pending || !checked.success || probing}>
                            {pending ? "Creating..." : "Create the pool"}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function Field({
    label,
    error,
    className,
    children
}: {
    label: string;
    error?: string | null;
    className?: string;
    children: React.ReactNode;
}) {
    return (
        <label className={`flex flex-col gap-1 text-sm ${className ?? ""}`}>
            {label}
            {children}
            {error ? <span className="text-xs text-danger">{error}</span> : null}
        </label>
    );
}

function Hint({ children }: { children: React.ReactNode }) {
    return <span className="text-xs text-muted-foreground">{children}</span>;
}

/** What the machine turned out to be. Shown because it decides the choice below
 *  it, and because "why can I not pick containers" needs an answer on screen. */
function MachineNote({ probing, readiness }: { probing: boolean; readiness: Readiness | null }) {
    if (probing) return <Hint>Asking the server what it can run...</Hint>;
    if (!readiness) return null;
    if (readiness.unsupported) return <span className="text-xs text-danger">{readiness.unsupported}</span>;
    return (
        <Hint>
            {readiness.platform} on {readiness.arch}
            {readiness.containerEngine ? ", container engine available" : ", no container engine for the Polaris login"}
        </Hint>
    );
}

function IsolationNote({ isolation, available }: { isolation: RunnerIsolation; available: boolean }) {
    if (isolation === "container") {
        return <Hint>Nothing survives the job. Steps that need a container engine of their own will not work.</Hint>;
    }
    return (
        <Hint>
            An empty directory, not a boundary: a job can reach whatever the Polaris login can.
            {available ? "" : " Add the container engine to this machine's Polaris login to isolate jobs properly."}
        </Hint>
    );
}
