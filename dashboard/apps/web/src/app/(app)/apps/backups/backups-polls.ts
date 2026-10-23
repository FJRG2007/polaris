/**
 * What the Backups screens read when they open, asked through routes (see
 * `lib/poll-route`): server actions from one tab run one at a time, so a read
 * on open waited behind every other one, and a press waited behind them all.
 * Each answers exactly what the action it replaces answers.
 */

import { readPoll } from "@/lib/poll-fetch";
import type * as backupsActionsModule from "@/app/(app)/apps/backups/actions";

type Answer<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

export const backupKeys = (signal?: AbortSignal) =>
    readPoll<Answer<typeof backupsActionsModule.listBackupKeysAction>>(
        "/api/backups/keys",
        {},
        signal
    );
