// @vitest-environment jsdom

/**
 * Opening Mail drew its skeleton and kept it until the page was reloaded.
 *
 * Three things could each hold it there, and a first sync - the minutes after a
 * mailbox is connected, storing mail folder by folder - set off all of them:
 *
 * - **Every frame called the list's request off.** The live channel says a
 *   mailbox moved every few hundred milliseconds through a first sync, each of
 *   those is a new `revision`, and a new `load` aborted the read still in the
 *   air. A list request slower than the gap between two frames never landed.
 * - **A steady stream of frames was never "settled".** The shell waited for a
 *   pause before asking again, and a first sync does not pause.
 * - **"Still fetching" had no end.** It held while the folder's count said it
 *   had mail and the list had none, whatever the server had since answered - a
 *   reach for older mail that failed or found nothing left it up for good.
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { useLiveRead } from "@/components/use-live-resource";
import { settleFrames } from "@/app/(app)/mail/stream-settle";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The package root, where vitest runs: `import.meta.url` is not a file URL
// under jsdom.
const SRC = join(process.cwd(), "src/");

/** A read that answers only when told to, with the signal it was given. */
function pending() {
    let resolve!: (value: string) => void;
    let signal!: AbortSignal;
    const promise = new Promise<string>((settle) => {
        resolve = settle;
    });
    const load = (given: AbortSignal) => {
        signal = given;
        return promise;
    };
    return { load, resolve, aborted: () => signal.aborted };
}

beforeEach(() => sessionStorage.clear());
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe("the list's request while the live channel keeps saying mail moved", () => {
    it("lands the first answer even though a newer request has left since", async () => {
        const first = pending();
        const second = pending();
        const { result, rerender } = renderHook(
            ({ load }) => useLiveRead<string>({ load, cacheKey: "mail.list.inbox" }),
            { initialProps: { load: first.load } }
        );
        expect(result.current.loading).toBe(true);

        // A frame: the same list, asked again.
        rerender({ load: second.load });
        expect(first.aborted()).toBe(false);

        await act(async () => first.resolve("rows from the first ask"));
        expect(result.current.loading).toBe(false);
        expect(result.current.data).toBe("rows from the first ask");

        await act(async () => second.resolve("rows from the second ask"));
        expect(result.current.data).toBe("rows from the second ask");
    });

    it("still drops an older answer that lands after a newer one", async () => {
        const first = pending();
        const second = pending();
        const { result, rerender } = renderHook(
            ({ load }) => useLiveRead<string>({ load, cacheKey: "mail.list.inbox" }),
            { initialProps: { load: first.load } }
        );
        rerender({ load: second.load });

        await act(async () => second.resolve("newer"));
        await act(async () => first.resolve("older"));
        expect(result.current.data).toBe("newer");
    });

    it("calls the request off when the list is a different one", () => {
        const inbox = pending();
        const trash = pending();
        const { rerender } = renderHook(
            ({ load, key }) => useLiveRead<string>({ load, cacheKey: key }),
            { initialProps: { load: inbox.load, key: "mail.list.inbox" } }
        );
        rerender({ load: trash.load, key: "mail.list.trash" });
        expect(inbox.aborted()).toBe(true);
        expect(trash.aborted()).toBe(false);
    });

    it("calls the request off when the screen goes away", () => {
        const read = pending();
        const { unmount } = renderHook(() =>
            useLiveRead<string>({ load: read.load, cacheKey: "mail.list.inbox" })
        );
        unmount();
        expect(read.aborted()).toBe(true);
    });
});

describe("frames gathered into a refresh", () => {
    it("refreshes once, a beat after a burst ends", () => {
        vi.useFakeTimers();
        const run = vi.fn();
        const settler = settleFrames(run, 400, 2_000);
        settler.frame();
        vi.advanceTimersByTime(100);
        settler.frame();
        vi.advanceTimersByTime(399);
        expect(run).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(run).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(5_000);
        expect(run).toHaveBeenCalledTimes(1);
    });

    it("keeps refreshing through a stream of frames that never pauses", () => {
        vi.useFakeTimers();
        const run = vi.fn();
        const settler = settleFrames(run, 400, 2_000);
        // A first sync: a frame every 300ms for ten seconds.
        for (let at = 0; at < 10_000; at += 300) {
            settler.frame();
            vi.advanceTimersByTime(300);
        }
        expect(run.mock.calls.length).toBeGreaterThanOrEqual(4);
    });

    it("asks for nothing once the screen has gone", () => {
        vi.useFakeTimers();
        const run = vi.fn();
        const settler = settleFrames(run, 400, 2_000);
        settler.frame();
        settler.cancel();
        vi.advanceTimersByTime(5_000);
        expect(run).not.toHaveBeenCalled();
    });

    it("is what the shell answers the live channel with", async () => {
        const shell = await readFile(`${SRC}app/(app)/mail/mail-shell.tsx`, "utf8");
        expect(shell).toContain("settleFrames(");
        expect(shell).toContain("STREAM_MAX_WAIT_MS");
        expect(shell).toContain("useMailStream(onFrame);");
    });
});

describe("the skeleton that says mail is still being fetched", () => {
    it("holds only while something is still on its way", async () => {
        const view = await readFile(`${SRC}app/(app)/mail/mail-view.tsx`, "utf8");
        expect(view).toContain(
            "const stillFetching = !narrowed && threads.length === 0 && serverHolds && waitingOnServer;"
        );
        expect(view).toContain(
            'const waitingOnServer = firstPass || (cursor !== "" && !olderFailed);'
        );
        expect(view).toContain("account.lastSyncAt === null");
    });

    it("turns a failed reach for older mail into a failure with a retry, not a wait", async () => {
        const view = await readFile(`${SRC}app/(app)/mail/mail-view.tsx`, "utf8");
        const reach = view.slice(view.indexOf("const loadMore = useCallback"));
        const body = reach.slice(0, reach.indexOf("}, [cursor,"));
        expect(body).toContain("if (!response.ok) throw new Error(LIST_NOT_LOADED);");
        expect(body).toContain("setOlderFailed(true);");
        expect(view).toContain(
            "list.failed ?? (olderFailed && threads.length === 0 ? LIST_NOT_LOADED : null)"
        );
        expect(view).toContain("onClick={list.failed ? refresh : loadMore}");
    });

    it("ends a reach that answered the same question the same way", async () => {
        const view = await readFile(`${SRC}app/(app)/mail/mail-view.tsx`, "utf8");
        expect(view).toContain(
            'setCursor(fresh.length === 0 && outcome.cursor === cursor ? "" : outcome.cursor);'
        );
    });
});
