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
 * The scope is asked the same way (see scope-field): what it comes to is looked up
 * while the rest of the form is being filled in, because a pool pointed at an
 * account is a promise about repositories nobody has listed.
 *
 * It validates against the same schema the action does, so a value the form
 * accepts is never one the server refuses on shape.
 */

import { useRouter } from "next/navigation";
import { ChevronRight, Plus } from "lucide-react";
import { RunsOnSnippet } from "./runs-on-snippet";
import { useCallback, useEffect, useState } from "react";
import type { RunnerHostReadiness } from "@/lib/runners/runner-service";
import { createRunnerPoolAction, probeRunnerHostAction } from "./actions";
import { EMPTY_SCOPE, ScopeField, toScope, type ScopeState } from "./scope-field";
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
import {
    createRunnerPoolSchema,
    DEFAULT_RUNNER_LABELS,
    MAX_RUNNER_CONCURRENCY,
    normalizeRunnerLabels,
    type RunnerExhaustedAction,
    type RunnerIsolation,
    type RunnerWindow
} from "@polaris/core";

export interface ServerOption {
    id: string;
    name: string;
    /** The box Polaris runs on, which it reaches through its container engine
     *  rather than a login - so it runs contained jobs or none. */
    local: boolean;
}

/** A limit field is empty when there is no limit of that kind, which is not the
 *  same as zero - zero would mean "may never run". */
function optional(value: string): number | null {
    const trimmed = value.trim();
    return trimmed === "" ? null : Number(trimmed);
}

export function PoolDialog({ servers }: { servers: ServerOption[] }) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [name, setName] = useState("");
    const [serverId, setServerId] = useState("");
    const [scope, setScope] = useState<ScopeState>(EMPTY_SCOPE);
    const [scopeCount, setScopeCount] = useState(0);
    const [labels, setLabels] = useState(DEFAULT_RUNNER_LABELS.join(", "));
    const [maxConcurrent, setMaxConcurrent] = useState("1");
    // Once somebody has set this themselves, picking another server stops
    // overwriting it with what that machine is worth.
    const [touchedConcurrency, setTouchedConcurrency] = useState(false);
    const [isolation, setIsolation] = useState<RunnerIsolation>("container");
    const [advanced, setAdvanced] = useState(false);
    const [perTarget, setPerTarget] = useState("");
    const [minutes, setMinutes] = useState("");
    const [window, setWindow] = useState<RunnerWindow>("month");
    const [jobsPerDay, setJobsPerDay] = useState("");
    const [onExhausted, setOnExhausted] = useState<RunnerExhaustedAction>("pause");
    const [readiness, setReadiness] = useState<RunnerHostReadiness | null>(null);
    const [probing, setProbing] = useState(false);
    const [probeError, setProbeError] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    const server = servers.find((entry) => entry.id === serverId) ?? null;
    // Normalized the way the schema will, so the summary and the runs-on line show
    // what the pool will actually register with rather than what was typed.
    const poolLabels = normalizeRunnerLabels(labels.split(","));
    // Named after what it serves when nobody bothered: a pool called "acme/website"
    // beats one called "New pool", and it is still theirs to change under Advanced.
    const proposedName = name.trim() || scope.repos[0]?.split("/")[1] || scope.owner || "Build";
    const draft = {
        serverId,
        name: proposedName,
        scope: toScope(scope),
        labels: labels.split(","),
        maxConcurrent,
        isolation,
        limits: {
            perTargetConcurrent: optional(perTarget),
            minutesBudget: optional(minutes),
            minutesWindow: window,
            jobsPerDay: optional(jobsPerDay),
            onExhausted
        }
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
            // What the machine is worth, not the smallest number that works. A pool
            // created on a 16-processor box and left at one runner is a box doing a
            // sixteenth of what it was offered for, and nobody goes back to change
            // it. Anything the operator typed themselves is left alone, and the
            // ceiling still applies.
            setMaxConcurrent((current) =>
                touchedConcurrency || Number(current) > machine.recommended
                    ? String(Math.min(Number(current) || 1, machine.recommended))
                    : String(Math.max(1, machine.recommended))
            );
        });
        return () => {
            live = false;
        };
    }, [serverId]);

    const onPreview = useCallback((result: { count: number }) => setScopeCount(result.count), []);

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
    // More repositories than slots is normal and is what the queue exists for, but
    // it is worth saying once rather than leaving somebody to notice.
    const spread = scopeCount > Number(maxConcurrent || 1);

    function reset() {
        setName("");
        // One server and nothing to choose: pick it, so the machine is probed while
        // the rest of the form is still being filled in.
        setServerId(servers.length === 1 ? (servers[0]?.id ?? "") : "");
        setScope(EMPTY_SCOPE);
        setScopeCount(0);
        setLabels(DEFAULT_RUNNER_LABELS.join(", "));
        setMaxConcurrent("1");
        setTouchedConcurrency(false);
        setIsolation("container");
        setAdvanced(false);
        setPerTarget("");
        setMinutes("");
        setWindow("month");
        setJobsPerDay("");
        setOnExhausted("pause");
        setReadiness(null);
        setProbeError(null);
        setError(null);
    }

    /** What is folded away, in one line, so nobody has to open it to find out
     *  whether anything in there needs their attention. */
    function advancedSummary(): string {
        const parts = [
            poolLabels.join(", ") || "no labels",
            `${maxConcurrent} ${Number(maxConcurrent) === 1 ? "job" : "jobs"} at once`,
            isolation === "container" ? "contained" : "a directory on the machine"
        ];
        const limits = [
            perTarget.trim() ? `${perTarget} each` : null,
            minutes.trim() ? `${minutes} min a ${window}` : null,
            jobsPerDay.trim() ? `${jobsPerDay} jobs a day` : null
        ].filter(Boolean);
        parts.push(limits.length > 0 ? limits.join(", ") : "no limits");
        return parts.join(", ");
    }

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
                if (next) reset();
                setOpen(next);
            }}
        >
            <DialogTrigger asChild>
                <Button size="sm" variant="secondary">
                    <Plus className="size-4" /> Add a pool
                </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>New runner pool</DialogTitle>
                    <DialogDescription>
                        Polaris keeps runners waiting on one of your servers. Workflows reach them with
                        <code className="mx-1 font-mono text-xs">runs-on</code>.
                    </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-3">
                    <Field label="Runs on" error={probeError}>
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

                    <ScopeField state={scope} onChange={setScope} onPreview={onPreview} />

                    {spread ? (
                        <Hint>
                            {scopeCount} repositories share {maxConcurrent}{" "}
                            {Number(maxConcurrent) === 1 ? "runner" : "runners"}. Whoever has a job queued gets them
                            first; the rest wait.
                        </Hint>
                    ) : null}

                    {/* Everything below is already answered from what the machine
                        reported, so it is folded away - but the summary says what it
                        was answered with, because a default nobody can see is a
                        default nobody can disagree with. */}
                    <div className="rounded-md border border-border/60">
                        <button
                            type="button"
                            onClick={() => setAdvanced((current) => !current)}
                            aria-expanded={advanced}
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/40"
                        >
                            <ChevronRight className={`size-4 shrink-0 transition-transform ${advanced ? "rotate-90" : ""}`} />
                            <span className="font-medium">Advanced</span>
                            {advanced ? null : (
                                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                                    {advancedSummary()}
                                </span>
                            )}
                        </button>

                        {advanced ? (
                            <div className="flex flex-col gap-3 border-t border-border/60 p-3">
                    <Field label="Name" error={name ? issue("name") : null}>
                        <Input
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder={proposedName}
                        />
                    </Field>

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
                                onChange={(event) => {
                                    setTouchedConcurrency(true);
                                    setMaxConcurrent(event.target.value);
                                }}
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

                    <div className="flex flex-col gap-2">
                        <span className="text-sm font-medium">Limits</span>
                        <Hint>Per repository. Leave a field empty for no limit of that kind.</Hint>

                        <div className="flex gap-2">
                            <Field label="At once" className="w-24" error={issue("limits")}>
                                <Input
                                    type="number"
                                    min={1}
                                    max={MAX_RUNNER_CONCURRENCY}
                                    inputMode="numeric"
                                    value={perTarget}
                                    placeholder="Any"
                                    onChange={(event) => setPerTarget(event.target.value)}
                                />
                            </Field>
                            <Field label="Minutes" className="w-28">
                                <Input
                                    type="number"
                                    min={1}
                                    inputMode="numeric"
                                    value={minutes}
                                    placeholder="Any"
                                    onChange={(event) => setMinutes(event.target.value)}
                                />
                            </Field>
                            <Field label="Per" className="w-28">
                                <Select
                                    value={window}
                                    onValueChange={(value) => setWindow(value as RunnerWindow)}
                                    options={[
                                        { value: "day", label: "Day" },
                                        { value: "month", label: "Month" }
                                    ]}
                                />
                            </Field>
                            <Field label="Jobs a day" className="flex-1">
                                <Input
                                    type="number"
                                    min={1}
                                    inputMode="numeric"
                                    value={jobsPerDay}
                                    placeholder="Any"
                                    onChange={(event) => setJobsPerDay(event.target.value)}
                                />
                            </Field>
                        </div>

                        <Field label="When a repository runs out">
                            <Select
                                value={onExhausted}
                                onValueChange={(value) => setOnExhausted(value as RunnerExhaustedAction)}
                                options={[
                                    { value: "pause", label: "Stop serving it until the window turns over" },
                                    { value: "warn", label: "Keep serving it, and say so on the pool" }
                                ]}
                            />
                        </Field>
                                </div>
                            </div>
                        ) : null}
                    </div>

                    <RunsOnSnippet labels={poolLabels} />

                    {error ? <p className="text-sm text-danger">{error}</p> : null}

                    <div className="mt-1 flex justify-end">
                        <Button
                            onClick={() => void submit()}
                            disabled={pending || !checked.success || probing || overCapacity || scopeCount === 0}
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
