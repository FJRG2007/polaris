"use client";

/**
 * Tasks' kinds of offline write: a task made, a change to one, a move
 * (`lib/offline/app-writes`).
 *
 * A write is tried at once, as it always was, when nothing for the same task is
 * still waiting and the device says it has a network. When Polaris cannot be
 * reached it is kept here instead and sent, in order, when Polaris answers
 * again - the screen shows it as written meanwhile, with a clock on the row.
 *
 * A task made here carries the id it will have on the server, so sending it
 * twice (an answer lost on the way back) makes it once. Its reference ("ENG-42")
 * is numbered by the server, so until it is sent it has none.
 */

import * as actions from "./actions";
import { useEffect, useState } from "react";
import { actionFailureText } from "@/lib/run-action";
import { noteRequestFailure } from "@/lib/reachability";
import { tryNow, UNANSWERED } from "@/lib/offline/try-now";
import { newClientKey, type QueueSendResult } from "@/lib/offline/outbox";
import { appWrites, offlineStore, registerWriteKind, type AppWrite } from "@/lib/offline/app-writes";

import { TASK_CREATE, TASK_MOVE, TASK_UPDATE } from "./offline-rows";

export { TASK_CREATE, TASK_MOVE, TASK_UPDATE };

const TASK_KINDS: readonly string[] = [TASK_CREATE, TASK_UPDATE, TASK_MOVE];

export type TaskWriteKind = typeof TASK_CREATE | typeof TASK_UPDATE | typeof TASK_MOVE;

/** What a create is sent with: the action's own input, plus the id it is made with. */
export type TaskCreatePayload = Record<string, unknown> & { readonly id: string; readonly listId: string; readonly name: string; };
/** A change or a move: the action's own input, naming the task. */
export type TaskChangePayload = Record<string, unknown> & { readonly taskId: string; };

// Looked up when called, not when this module loads.
const call: Record<TaskWriteKind, (payload: Record<string, unknown>) => Promise<{ id?: string; error?: string; }>> = {
    [TASK_CREATE]: (payload) => actions.createTaskAction(payload),
    [TASK_UPDATE]: (payload) => actions.updateTaskAction(payload),
    [TASK_MOVE]: (payload) => actions.moveTaskAction(payload)
};

async function deliver(entry: Pick<AppWrite, "kind" | "target" | "payload">): Promise<QueueSendResult> {
    try {
        const result = await call[entry.kind as TaskWriteKind](entry.payload as Record<string, unknown>);
        return result.error ? { refused: result.error } : { sent: result.id ?? entry.target };
    } catch (caught) {
        noteRequestFailure(caught);
        return "unreachable";
    }
}

for (const kind of TASK_KINDS) registerWriteKind(kind, deliver);

/** The fields of a task write that name another task. */
const TASK_REFERENCES = ["parentId", "beforeId", "afterId"] as const;

const isTaskWrite = (entry: AppWrite): boolean => TASK_KINDS.includes(entry.kind);

async function taskWrites(): Promise<AppWrite[]> {
    return (await appWrites.readAll())
        .filter(isTaskWrite)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Keep a write in line behind what is already waiting for the same task. A
 * change right behind another change to the same task folds into it (the newer
 * value of each field wins), and so does a move behind a move; anything else
 * is kept as its own entry, so the order the reader did things in survives.
 */
async function keep(kind: TaskWriteKind, target: string, payload: Record<string, unknown>): Promise<boolean> {
    const run = async (): Promise<boolean> => {
        const waiting = (await taskWrites()).filter((entry) => entry.target === target && entry.state === "pending");
        const last = waiting.at(-1);
        const folds = last !== undefined && last.kind === kind && kind !== TASK_CREATE;
        const merged = folds ? { ...(last.payload as Record<string, unknown>), ...payload } : payload;
        const kept = await appWrites.enqueue({ key: newClientKey(), kind, target, payload: merged });
        if (kept && folds) await offlineStore.forget("writes", last.key);
        return kept;
    };
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    const owner = offlineStore.owner();
    return locks && owner ? locks.request(`polaris-task-writes:${owner}`, run) : run();
}

/** What a task write answered: the action's own answer, or that it was kept
 *  on this device to be sent later (`queued`), with no error. */
export type TaskWriteResult = { id?: string; reference?: string; error?: string; queued?: true; };

/**
 * Write a task now, or keep the write for when Polaris answers. Answers what the
 * action answered when it was sent, `{ queued: true }` when it was kept (no
 * answer, or the device is offline), and null when it failed otherwise - the
 * server threw, or there was nowhere to keep it (`onFailure` was told).
 */
export async function writeTask(
    kind: TaskWriteKind,
    payload: Record<string, unknown>,
    onFailure: (message: string) => void
): Promise<TaskWriteResult | null> {
    // A task made here is made with its id, so a retry after a lost answer
    // finds it already there instead of making a second one.
    const input = kind === TASK_CREATE && typeof payload.id !== "string" ? { ...payload, id: newClientKey() } : payload;
    const target = kind === TASK_CREATE ? (input.id as string) : String(input.taskId);
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    // Behind anything still waiting for this task or for a task it names - a
    // subtask under a parent made offline, a move next to one - so the server
    // has those before it reads this.
    const named = new Set([target, ...TASK_REFERENCES.map((field) => input[field]).filter((id) => typeof id === "string")]);
    const behind = (await taskWrites()).some((entry) => named.has(entry.target) && entry.state === "pending");

    if (!offline && !behind) {
        // Not answered: kept below, and sent when Polaris is back. Anything else
        // (the server threw, a replaced build) fails as it always did.
        const answer = await tryNow(() => call[kind](input), onFailure);
        if (answer !== UNANSWERED) return answer;
    }
    if (await keep(kind, target, input)) {
        appWrites.flush();
        return { queued: true };
    }
    // Nowhere to keep it (no account on this device, storage refused).
    onFailure(actionFailureText());
    return null;
}

export interface TaskWritesState {
    /** Every waiting or failed task write, oldest first. */
    readonly entries: readonly AppWrite[];
    /** Per task, whether something for it is waiting, or was not taken. */
    readonly states: ReadonlyMap<string, "pending" | "failed">;
}

const EMPTY: TaskWritesState = { entries: [], states: new Map() };

function stateOf(entries: readonly AppWrite[]): TaskWritesState {
    const states = new Map<string, "pending" | "failed">();
    for (const entry of entries) {
        if (states.get(entry.target) === "failed") continue;
        states.set(entry.target, entry.state);
    }
    return { entries, states };
}

/**
 * The task writes kept on this device, kept current. `onSent` hears every write
 * the server took, so a screen can fetch what the server now has.
 */
export function useTaskWrites(onSent?: (entry: AppWrite) => void): TaskWritesState {
    const [state, setState] = useState<TaskWritesState>(EMPTY);
    useEffect(() => {
        let live = true;
        const reload = () =>
            void taskWrites().then(
                (entries) => live && setState(stateOf(entries)),
                () => undefined
            );
        reload();
        const unsubscribe = appWrites.subscribe((event) => {
            if (event && !isTaskWrite(event.entry)) return;
            if (event && "sent" in event) onSent?.(event.entry);
            reload();
        });
        return () => {
            live = false;
            unsubscribe();
        };
        // `onSent` is read when an event arrives; a new closure each render
        // must not resubscribe.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return state;
}
