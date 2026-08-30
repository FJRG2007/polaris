"use client";

/**
 * Sprints and goals: the two planning screens.
 *
 * Both are about a commitment and whether it is being met, so they share a
 * module and a visual language - a bar that fills, a number that moves, and a
 * date that is either ahead or behind. A sprint burndown deliberately stops at
 * today rather than running to zero, because a line that reaches the axis on a
 * chart of unfinished work is the most common lie in project software.
 */

import { useState } from "react";
import * as actions from "./actions";
import * as core from "@polaris/core";
import { ProgressBar } from "./pickers";
import { runAction } from "@/lib/run-action";
import { useDisplayFormat } from "@/components/display-format";
import { CalendarRange, Plus, Target, Trash2, Users } from "lucide-react";
import { Button, Card, CardBody, EmptyState, Input, Select, cn } from "@polaris/ui";
import type { GoalView, SprintView } from "@/lib/tasks/planning-service";
import { AccessDialog, type AccessTarget } from "./access-dialog";

// ---------------------------------------------------------------------------
// Sprints
// ---------------------------------------------------------------------------

export function SprintsView({
    sprints,
    spaces,
    burndowns,
    canEdit
}: {
    sprints: readonly (SprintView & { spaceId: string; spaceName: string })[];
    spaces: readonly { id: string; name: string }[];
    /** Points still open per day, keyed by sprint id. */
    burndowns: Readonly<Record<string, core.BurndownPoint[]>>;
    /** Whether this account may change the plan at all. Reading it is a
     *  different permission from reshaping it, and the buttons that reshape it
     *  are not drawn for somebody who only holds the first. */
    canEdit: boolean;
}) {
    const format = useDisplayFormat();
    const [creating, setCreating] = useState(false);
    const [spaceId, setSpaceId] = useState(spaces[0]?.id ?? "");
    const [name, setName] = useState("");
    const [start, setStart] = useState("");
    const [end, setEnd] = useState("");
    const [error, setError] = useState("");
    const [access, setAccess] = useState<AccessTarget | null>(null);

    return (
        <div className="flex min-w-0 flex-1 flex-col gap-5">
            <AccessDialog target={access} onClose={() => setAccess(null)} />
            <header className="flex flex-wrap items-center gap-3">
                <div>
                    <h1 className="text-[17px] font-semibold tracking-tight">Sprints</h1>
                    <p className="text-sm text-muted-foreground">Time-boxed runs of work, with what is left each day.</p>
                </div>
                <span className="flex-1" />
                {canEdit && spaces.length > 0 && !creating && (
                    <Button size="sm" onClick={() => setCreating(true)}>
                        <Plus className="size-4" /> New sprint
                    </Button>
                )}
            </header>

            {error && (
                <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
                    {error}
                </p>
            )}

            {creating && (
                <Card>
                    <CardBody className="flex flex-wrap items-end gap-2 p-4">
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                            Space
                            <Select
                                value={spaceId}
                                onValueChange={setSpaceId}
                                options={spaces.map((space) => ({ value: space.id, label: space.name }))}
                                aria-label="Space"
                                className="h-8 w-40 text-xs"
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                            Name
                            <Input
                                value={name}
                                onChange={(event) => setName(event.target.value)}
                                placeholder="Sprint 14"
                                className="h-8 w-40 text-sm"
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                            Starts
                            <input
                                type="date"
                                value={start}
                                onChange={(event) => setStart(event.target.value)}
                                className="h-8 rounded-md border border-border bg-field px-2 text-xs"
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                            Ends
                            <input
                                type="date"
                                value={end}
                                onChange={(event) => setEnd(event.target.value)}
                                className="h-8 rounded-md border border-border bg-field px-2 text-xs"
                            />
                        </label>
                        <Button
                            size="sm"
                            disabled={!name.trim() || !start || !end || !spaceId}
                            onClick={async () => {
                                setError("");
                                const result = await runAction(
                                    () =>
                                        actions.createSprintAction({
                                            spaceId,
                                            name: name.trim(),
                                            startDate: new Date(start).toISOString(),
                                            endDate: new Date(`${end}T23:59:59`).toISOString()
                                        }),
                                    setError
                                );
                                if (result?.error) setError(result.error);
                                else {
                                    setCreating(false);
                                    setName("");
                                }
                            }}
                        >
                            Create
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
                            Cancel
                        </Button>
                    </CardBody>
                </Card>
            )}

            {sprints.length === 0 && !creating && (
                <EmptyState title="No sprints yet." description="A sprint groups work into a window without moving it out of its list." />
            )}

            <ul className="flex flex-col gap-3">
                {sprints.map((sprint) => {
                    const points = burndowns[sprint.id] ?? [];
                    const percent = sprint.points > 0
                        ? Math.round((sprint.donePoints / sprint.points) * 100)
                        : sprint.taskCount > 0
                          ? Math.round((sprint.doneCount / sprint.taskCount) * 100)
                          : 0;
                    return (
                        <li key={sprint.id}>
                            <Card>
                                <CardBody className="flex flex-col gap-3 p-4">
                                    <div className="flex flex-wrap items-center gap-3">
                                        <CalendarRange className="size-4 text-muted-foreground" />
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate font-medium">
                                                {sprint.name}
                                                <span className="ml-2 text-xs font-normal text-muted-foreground">
                                                    {sprint.spaceName}
                                                </span>
                                            </p>
                                            <p className="text-xs text-muted-foreground">
                                                {format.date(sprint.startDate)} to {format.date(sprint.endDate)} -{" "}
                                                {sprint.doneCount} of {sprint.taskCount} done
                                                {sprint.points > 0 ? `, ${sprint.donePoints}/${sprint.points} points` : ""}
                                            </p>
                                        </div>
                                        <Select
                                            disabled={!canEdit}
                                            value={sprint.status}
                                            onValueChange={async (status) => {
                                                const result = await runAction(
                                                    () =>
                                                        actions.setSprintStatusAction(
                                                            sprint.spaceId,
                                                            sprint.id,
                                                            status as SprintView["status"]
                                                        ),
                                                    setError
                                                );
                                                if (result?.error) setError(result.error);
                                            }}
                                            options={[
                                                { value: "planned", label: "Planned" },
                                                { value: "active", label: "Active" },
                                                { value: "completed", label: "Completed" }
                                            ]}
                                            aria-label={`Status of ${sprint.name}`}
                                            className="h-8 w-32 text-xs"
                                        />
                                        {canEdit && (
                                            <button
                                                type="button"
                                                aria-label={`Who can reach ${sprint.name}`}
                                                title="Who can reach this"
                                                onClick={() =>
                                                    setAccess({
                                                        scope: sprint.folderId
                                                            ? { kind: "folder", id: sprint.folderId }
                                                            : { kind: "space", id: sprint.spaceId },
                                                        asked: { kind: "sprint", name: sprint.name }
                                                    })
                                                }
                                                className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                            >
                                                <Users className="size-3.5" />
                                            </button>
                                        )}
                                        {canEdit && <button
                                            type="button"
                                            aria-label={`Delete ${sprint.name}`}
                                            title="Delete sprint"
                                            onClick={async () => {
                                                const result = await runAction(
                                                    () => actions.deleteSprintAction(sprint.spaceId, sprint.id),
                                                    setError
                                                );
                                                if (result?.error) setError(result.error);
                                            }}
                                            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-danger"
                                        >
                                            <Trash2 className="size-3.5" />
                                        </button>}
                                    </div>

                                    <ProgressBar percent={percent} />

                                    {points.length > 1 && <Burndown points={points} />}
                                </CardBody>
                            </Card>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

/** A burndown drawn as two inline paths: what should be left, and what is. */
function Burndown({ points }: { points: readonly core.BurndownPoint[] }) {
    const max = Math.max(1, ...points.map((point) => point.ideal));
    const width = 100;
    const height = 40;
    const at = (index: number, value: number) =>
        `${(index / Math.max(1, points.length - 1)) * width},${height - (value / max) * height}`;

    const ideal = points.map((point, index) => at(index, point.ideal)).join(" ");
    const actual = points
        .map((point, index) => (point.remaining === null ? null : at(index, point.remaining)))
        .filter((entry): entry is string => entry !== null)
        .join(" ");

    return (
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-16 w-full" role="img" aria-label="Burndown">
            <polyline points={ideal} fill="none" stroke="currentColor" strokeWidth="0.5" className="text-muted-foreground/40" />
            <polyline points={actual} fill="none" stroke="currentColor" strokeWidth="1" className="text-primary" />
        </svg>
    );
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

export function GoalsView({
    goals,
    spaces,
    lists,
    canEdit
}: {
    goals: readonly GoalView[];
    spaces: readonly { id: string; name: string }[];
    lists: readonly { id: string; name: string }[];
    /** Whether this account may change the plan. See SprintsView. */
    canEdit: boolean;
}) {
    const format = useDisplayFormat();
    const [creating, setCreating] = useState(false);
    const [name, setName] = useState("");
    const [spaceId, setSpaceId] = useState("");
    const [error, setError] = useState("");
    const [targetFor, setTargetFor] = useState<string | null>(null);

    return (
        <div className="flex min-w-0 flex-1 flex-col gap-5">
            <header className="flex flex-wrap items-center gap-3">
                <div>
                    <h1 className="text-[17px] font-semibold tracking-tight">Goals</h1>
                    <p className="text-sm text-muted-foreground">
                        Objectives measured by targets. A target that watches a list keeps itself current.
                    </p>
                </div>
                <span className="flex-1" />
                {canEdit && !creating && (
                    <Button size="sm" onClick={() => setCreating(true)}>
                        <Plus className="size-4" /> New goal
                    </Button>
                )}
            </header>

            {error && (
                <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
                    {error}
                </p>
            )}

            {creating && (
                <Card>
                    <CardBody className="flex flex-wrap items-end gap-2 p-4">
                        <Input
                            value={name}
                            placeholder="Ship the new billing flow"
                            aria-label="Goal name"
                            onChange={(event) => setName(event.target.value)}
                            className="h-8 w-64 text-sm"
                        />
                        <Select
                            value={spaceId}
                            onValueChange={setSpaceId}
                            options={[
                                { value: "", label: "Not tied to a space" },
                                ...spaces.map((space) => ({ value: space.id, label: space.name }))
                            ]}
                            aria-label="Space"
                            className="h-8 w-44 text-xs"
                        />
                        <Button
                            size="sm"
                            disabled={!name.trim()}
                            onClick={async () => {
                                setError("");
                                const result = await runAction(
                                    () => actions.createGoalAction({ name: name.trim(), spaceId: spaceId || null }),
                                    setError
                                );
                                if (result?.error) setError(result.error);
                                else {
                                    setCreating(false);
                                    setName("");
                                }
                            }}
                        >
                            Create
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
                            Cancel
                        </Button>
                    </CardBody>
                </Card>
            )}

            {goals.length === 0 && !creating && (
                <EmptyState title="No goals yet." description="A goal is the outcome; the tasks are how you get there." />
            )}

            <ul className="grid gap-3 md:grid-cols-2">
                {goals.map((goal) => (
                    <li key={goal.id}>
                        <Card>
                            <CardBody className="flex flex-col gap-3 p-4">
                                <div className="flex items-start gap-3">
                                    <Target className="mt-0.5 size-4" style={{ color: goal.color }} />
                                    <div className="min-w-0 flex-1">
                                        <p className={cn("truncate font-medium", goal.completedAt && "text-muted-foreground")}>
                                            {goal.name}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            {goal.ownerName}
                                            {goal.dueDate ? ` - due ${format.date(goal.dueDate)}` : ""}
                                        </p>
                                    </div>
                                    <span className="text-sm font-semibold">{goal.percent}%</span>
                                    {canEdit && <button
                                        type="button"
                                        aria-label={`Delete ${goal.name}`}
                                        title="Delete goal"
                                        onClick={async () => {
                                            const result = await runAction(() => actions.deleteGoalAction(goal.id), setError);
                                            if (result?.error) setError(result.error);
                                        }}
                                        className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-danger"
                                    >
                                        <Trash2 className="size-3.5" />
                                    </button>}
                                </div>

                                <ProgressBar percent={goal.percent} />

                                <ul className="flex flex-col gap-2">
                                    {goal.targets.map((target) => (
                                        <li key={target.id} className="flex items-center gap-2 text-xs">
                                            <span className="min-w-0 flex-1 truncate">{target.name}</span>
                                            {target.type === "tasks" ? (
                                                <span className="text-muted-foreground">
                                                    {target.currentValue}/{target.targetValue} tasks
                                                </span>
                                            ) : (
                                                <input
                                                    type="number"
                                                    disabled={!canEdit}
                                                    defaultValue={target.currentValue}
                                                    aria-label={`Value for ${target.name}`}
                                                    onBlur={async (event) => {
                                                        const value = Number(event.target.value);
                                                        if (value === target.currentValue) return;
                                                        const result = await runAction(
                                                            () => actions.setGoalTargetValueAction(target.id, value),
                                                            setError
                                                        );
                                                        if (result?.error) setError(result.error);
                                                    }}
                                                    className="h-7 w-20 rounded-md border border-border bg-field px-2 text-xs"
                                                />
                                            )}
                                            <span className="w-10 text-right text-muted-foreground">{target.percent}%</span>
                                            {canEdit && <button
                                                type="button"
                                                aria-label={`Remove ${target.name}`}
                                                title="Remove target"
                                                onClick={async () => {
                                                    const result = await runAction(
                                                        () => actions.deleteGoalTargetAction(target.id),
                                                        setError
                                                    );
                                                    if (result?.error) setError(result.error);
                                                }}
                                                className="rounded p-0.5 text-muted-foreground transition-colors hover:text-danger"
                                            >
                                                <Trash2 className="size-3" />
                                            </button>}
                                        </li>
                                    ))}
                                    {goal.targets.length === 0 && (
                                        <li className="text-xs text-muted-foreground">
                                            No targets yet, so there is nothing to measure.
                                        </li>
                                    )}
                                </ul>

                                {!canEdit ? null : targetFor === goal.id ? (
                                    <TargetForm
                                        lists={lists}
                                        onCancel={() => setTargetFor(null)}
                                        onAdd={async (input) => {
                                            const result = await runAction(
                                                () => actions.addGoalTargetAction(goal.id, input),
                                                setError
                                            );
                                            if (result?.error) setError(result.error);
                                            else setTargetFor(null);
                                        }}
                                    />
                                ) : (
                                    <Button size="sm" variant="ghost" onClick={() => setTargetFor(goal.id)}>
                                        <Plus className="size-3.5" /> Target
                                    </Button>
                                )}
                            </CardBody>
                        </Card>
                    </li>
                ))}
            </ul>
        </div>
    );
}

function TargetForm({
    lists,
    onAdd,
    onCancel
}: {
    lists: readonly { id: string; name: string }[];
    onAdd: (input: Record<string, unknown>) => Promise<void>;
    onCancel: () => void;
}) {
    const [name, setName] = useState("");
    const [type, setType] = useState<core.GoalTargetType>("number");
    const [targetValue, setTargetValue] = useState("100");
    const [listId, setListId] = useState("");

    return (
        <div className="flex flex-wrap items-end gap-2 rounded-md border border-border p-2">
            <Input
                value={name}
                placeholder="Target name"
                aria-label="Target name"
                onChange={(event) => setName(event.target.value)}
                className="h-8 w-40 text-sm"
            />
            <Select
                value={type}
                onValueChange={(value) => setType(value as core.GoalTargetType)}
                options={core.GOAL_TARGET_TYPES.map((entry) => ({
                    value: entry,
                    label: core.GOAL_TARGET_LABELS[entry]
                }))}
                aria-label="Target type"
                className="h-8 w-36 text-xs"
            />
            {type === "tasks" ? (
                <Select
                    value={listId}
                    onValueChange={setListId}
                    options={lists.map((list) => ({ value: list.id, label: list.name }))}
                    placeholder="Which list"
                    aria-label="List to count"
                    className="h-8 w-40 text-xs"
                />
            ) : (
                <Input
                    type="number"
                    value={targetValue}
                    aria-label="Target value"
                    onChange={(event) => setTargetValue(event.target.value)}
                    className="h-8 w-24 text-sm"
                />
            )}
            <Button
                size="sm"
                disabled={!name.trim() || (type === "tasks" && !listId)}
                onClick={() =>
                    onAdd({
                        name: name.trim(),
                        type,
                        targetValue: Number(targetValue) || 100,
                        listId: type === "tasks" ? listId : null
                    })
                }
            >
                Add
            </Button>
            <Button size="sm" variant="ghost" onClick={onCancel}>
                Cancel
            </Button>
        </div>
    );
}
