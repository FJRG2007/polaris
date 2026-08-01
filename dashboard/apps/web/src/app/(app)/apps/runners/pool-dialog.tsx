"use client";

/**
 * Create a runner pool.
 *
 * The form asks the machine what it can do the moment a server is picked, rather
 * than offering every isolation choice and letting the server reject one at the
 * end. That is the difference between "containers are unavailable on this machine,
 * here is why" and a save button that fails after the operator has filled in
 * everything else. The same answer carries what the machine has, so the number of
 * jobs it offers is one the machine can actually carry - a pool sized past it does
 * not fail here, it fails hours later as a build that ran out of memory.
 *
 * It validates against the same schema the action does, so a value the form
 * accepts is never one the server refuses on shape.
 */

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { RunnerHostReadiness } from "@/lib/runners/runner-service";
import { createRunnerPoolAction, probeRunnerHostAction } from "./actions";
import {
    createRunnerPoolSchema,
    DEFAULT_RUNNER_LABELS,
    MAX_RUNNER_CONCURRENCY,
    type RunnerIsolation,
    type RunnerScope
} from "@polaris/core";
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

export interface ServerOption {
    id: string;
    name: string;
    /** The box Polaris runs on, which it reaches through its container engine
     *  rather than a login - so it runs contained jobs or none. */
    local: boolean;
}

const SCOPE_OPTIONS = [
    { value: "repo", label: "One repository" },
    { value: "org", label: "A whole organization" }
];

export function PoolDialog({ servers }: { servers: ServerOption[] }) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [name, setName] = useState("");
    const [serverId, setServerId] = useState("");
    const [scope, setScope] = useState<RunnerScope>("repo");
    const [targetOwner, setTargetOwner] = useState("");
    const [targetRepo, setTargetRepo] = useState("");
    const [labels, setLabels] = useState(DEFAULT_RUNNER_LABELS.join(", "));
    const [maxConcurrent, setMaxConcurrent] = useState("1");
    const [isolation, setIsolation] = useState<RunnerIsolation>("container");
    const [readiness, setReadiness] = useState<RunnerHostReadiness | null>(null);
    const [probing, setProbing] = useState(false);
    const [probeError, setProbeError] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    const server = servers.find((entry) => entry.id === serverId) ?? null;
    const draft = {
        serverId,
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
        if (!serverId) return;
        let live = true;
        setProbing(true);
        setReadiness(null);
        setProbeError(null);
        void probeRunnerHostAction(serverId).then((result) => {
            if (!live) return;
            setProbing(false);
            const machine = result.readiness;
            if (result.error || !machine) {
                setProbeError(result.error ?? "Could not reach that server");
                return;
            }
            setReadiness(machine);
            if (!machine.containerEngine && machine.reach === "login") setIsolation("workspace");
            // Never offer more than the machine can carry, including when the
            // operator already typed a bigger number for a different server.
            setMaxConcurrent((current) =>
                Number(current) > machine.recommended ? String(machine.recommended) : current
            );
        });
        return () => {
            live = false;
        };
    }, [serverId]);

    const containersAvailable = readiness !== null && readiness.platform === "linux" && readiness.containerEngine;
    // The local box has no login to give a job a directory under, so a clean
    // workspace is not one of its options rather than a worse one.
    const workspaceAvailable = readiness === null || readiness.reach === "login";
    const isolationOptions = [
        { value: "container", label: "Its own container", disabled: !containersAvailable },
        { value: "workspace", label: "A clean directory on the machine", disabled: !workspaceAvailable }
    ];
    const ceiling = readiness?.recommended ?? MAX_RUNNER_CONCURRENCY;
    const overCapacity = readiness !== null && Number(maxConcurrent) > readiness.recommended;

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
                    // One server and nothing to choose: pick it, so the machine is
                    // probed while the rest of the form is still being filled in.
                    setServerId(servers.length === 1 ? (servers[0]?.id ?? "") : "");
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
                <Button size="sm" variant="secondary">
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
                            value={serverId}
                            onValueChange={setServerId}
                            placeholder="Pick a server"
                            options={servers.map((entry) => ({
                                value: entry.id,
                                label: entry.local ? `${entry.name} (this machine)` : entry.name
                            }))}
                        />
                        <MachineNote probing={probing} readiness={readiness} local={server?.local ?? false} />
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
                        <Field
                            label="Jobs at once"
                            error={
                                overCapacity
                                    ? `This machine is worth about ${readiness?.recommended}`
                                    : issue("maxConcurrent")
                            }
                            className="w-32"
                        >
                            <Input
                                type="number"
                                min={1}
                                max={Math.min(ceiling, MAX_RUNNER_CONCURRENCY)}
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
                            <IsolationNote
                                isolation={isolation}
                                available={containersAvailable}
                                local={server?.local ?? false}
                            />
                        </Field>
                    </div>

                    {error ? <p className="text-sm text-danger">{error}</p> : null}

                    <div className="mt-1 flex justify-end">
                        <Button
                            onClick={() => void submit()}
                            disabled={pending || !checked.success || probing || overCapacity}
                        >
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

/** What the machine turned out to be, and what it has. Shown because it decides
 *  both choices below it, and because "why can I not pick containers" and "why
 *  only two jobs" both need an answer on screen. */
function MachineNote({
    probing,
    readiness,
    local
}: {
    probing: boolean;
    readiness: RunnerHostReadiness | null;
    local: boolean;
}) {
    if (probing) return <Hint>Asking the server what it can run...</Hint>;
    if (!readiness) return null;
    if (readiness.unsupported) return <span className="text-xs text-danger">{readiness.unsupported}</span>;
    return (
        <Hint>
            {readiness.platform} on {readiness.arch}
            {readiness.containerEngine
                ? ""
                : local
                  ? ", no container engine Polaris can reach"
                  : ", no container engine for the Polaris login"}
            . {readiness.capacityNote}
        </Hint>
    );
}

function IsolationNote({
    isolation,
    available,
    local
}: {
    isolation: RunnerIsolation;
    available: boolean;
    local: boolean;
}) {
    if (isolation === "container") {
        return <Hint>Nothing survives the job. Steps that need a container engine of their own will not work.</Hint>;
    }
    if (local) {
        return <Hint>Not available here: Polaris reaches this machine through its container engine only.</Hint>;
    }
    return (
        <Hint>
            An empty directory, not a boundary: a job can reach whatever the Polaris login can.
            {available ? "" : " Add the container engine to this machine's Polaris login to isolate jobs properly."}
        </Hint>
    );
}
