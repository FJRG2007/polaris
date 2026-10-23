/**
 * What the Office menus and dialogs read when they open, asked through routes (see
 * `lib/poll-route`): server actions from one tab run one at a time, so a read
 * on open waited behind every other one, and a press waited behind them all.
 * Each answers exactly what the action it replaces answers.
 */

import { readPoll } from "@/lib/poll-fetch";
import type * as linkActionsModule from "@/app/(app)/office/link-actions";
import type * as googleActionsModule from "@/app/(app)/office/google-actions";

type Answer<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

export const googleLink = (documentId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof googleActionsModule.officeGoogleLinkAction>>(
        "/api/office/google-link",
        { documentId },
        signal
    );

export const googleState = (signal?: AbortSignal) =>
    readPoll<Answer<typeof googleActionsModule.officeGoogleStateAction>>(
        "/api/office/google-state",
        {},
        signal
    );

export const googleFiles = (
    input: Parameters<typeof googleActionsModule.listGoogleFilesAction>[0],
    signal?: AbortSignal
) =>
    readPoll<Answer<typeof googleActionsModule.listGoogleFilesAction>>(
        "/api/office/google-files",
        { input: JSON.stringify(input) },
        signal
    );

export const links = (documentId: string, signal?: AbortSignal) =>
    readPoll<Answer<typeof linkActionsModule.listLinksAction>>(
        "/api/office/links",
        { documentId },
        signal
    );
