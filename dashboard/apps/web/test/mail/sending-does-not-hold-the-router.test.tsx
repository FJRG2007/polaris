// @vitest-environment jsdom

/**
 * Why sending a message left every link dead until a reload.
 *
 * The composer sent inside `useTransition`, awaiting the draft queue and a
 * server action. An async transition is not a spinner: while one is pending,
 * every transition started anywhere joins it and cannot commit until it ends -
 * and every navigation in Polaris (a link, `router.push`) is a transition. So
 * for as long as Send was waiting, clicking Inbox did nothing. And a server
 * action can wait forever: the router runs them one at a time, and one
 * dispatched while a navigation is still loading, after it superseded the action
 * before it, is appended behind an entry that is no longer in the queue and never
 * runs. Its promise never settles, the transition never ends, and nothing
 * navigates again until the page is reloaded. The draft is written on a timer
 * the whole time a composer is open, which is what made that window easy to hit.
 *
 * Two things are pinned here. Mail waits on the server with a busy count, never
 * a transition - shown by what each does to somebody else's transition, not only
 * by reading the source. And the composer's four requests are plain fetches to
 * routes, which belong to nobody but the composer and always answer.
 */

import { resolve } from "node:path";
import { useBusy } from "@/app/(app)/mail/use-busy";
import { readdir, readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { startTransition, useState, useTransition, type ReactNode } from "react";

// Resolved from where the suite runs: under jsdom `import.meta.url` is not a
// file address.
const SRC = `${resolve("src")}/`;
const MAIL = `${SRC}app/(app)/mail/`;

afterEach(cleanup);

/** A navigation, as the router makes one: a state update inside a transition. */
let navigate: (to: string) => void = () => undefined;
function Page(): ReactNode {
    const [page, setPage] = useState("inbox");
    navigate = (to) => startTransition(() => setPage(to));
    return <p data-testid="page">{page}</p>;
}

/** Something pressed that is still waiting on the server, and will be forever. */
const never = () => new Promise<void>(() => undefined);

let pressWithTransition: (task: () => Promise<void>) => void = () => undefined;
function WithTransition(): ReactNode {
    const [pending, start] = useTransition();
    pressWithTransition = (task) => start(task);
    return <span data-testid="pending">{String(pending)}</span>;
}

let pressWithBusy: (task: () => unknown) => void = () => undefined;
function WithBusy(): ReactNode {
    const [busy, run] = useBusy();
    pressWithBusy = run;
    return <span data-testid="busy">{String(busy)}</span>;
}

describe("what a pending press does to a navigation", () => {
    it("holds it, when the press is an async transition - the defect", async () => {
        render(
            <>
                <Page />
                <WithTransition />
            </>
        );
        // Answered here only so this test can end: a server action that was
        // dropped never answers, and then nothing below it ever lands. Left
        // unanswered, it holds every later test's navigation too - the same
        // scope the whole tab shares, which is why only a reload cleared it.
        let answer: () => void = () => undefined;
        await act(async () => pressWithTransition(() => new Promise((done) => (answer = done))));
        await act(async () => navigate("sent"));
        // Still on the inbox: the navigation joined the transition that is
        // waiting on the server, and waits with it.
        expect(screen.getByTestId("page").textContent).toBe("inbox");
        await act(async () => answer());
        expect(screen.getByTestId("page").textContent).toBe("sent");
    });

    it("leaves it alone, when the press is a busy count", async () => {
        render(
            <>
                <Page />
                <WithBusy />
            </>
        );
        await act(async () => pressWithBusy(never));
        expect(screen.getByTestId("busy").textContent).toBe("true");
        await act(async () => navigate("sent"));
        expect(screen.getByTestId("page").textContent).toBe("sent");
    });
});

describe("the busy count", () => {
    it("runs the press at once and comes down when it settles", async () => {
        render(<WithBusy />);
        let finish: () => void = () => undefined;
        let started = false;
        await act(async () =>
            pressWithBusy(() => {
                started = true;
                return new Promise<void>((resolve) => (finish = resolve));
            })
        );
        expect(started).toBe(true);
        expect(screen.getByTestId("busy").textContent).toBe("true");
        await act(async () => finish());
        expect(screen.getByTestId("busy").textContent).toBe("false");
    });

    it("comes down on a failure too, and says so in the log", async () => {
        const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
        render(<WithBusy />);
        await act(async () => pressWithBusy(async () => Promise.reject(new Error("refused"))));
        expect(screen.getByTestId("busy").textContent).toBe("false");
        expect(logged).toHaveBeenCalled();
        logged.mockRestore();
    });
});

/** Every source file under Mail's screens. */
async function mailSources(dir = MAIL): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = `${dir}${entry.name}`;
        if (entry.isDirectory()) found.push(...(await mailSources(`${path}/`)));
        else if (/\.tsx?$/.test(entry.name)) found.push(path);
    }
    return found;
}

describe("Mail's screens", () => {
    it("never wait on the server inside a transition", async () => {
        const offenders: string[] = [];
        for (const file of await mailSources()) {
            if (file.endsWith("use-busy.ts")) continue;
            const source = await readFile(file, "utf8");
            if (/\buseTransition\b|\bstartTransition\b/.test(source)) offenders.push(file.slice(MAIL.length));
        }
        expect(offenders).toEqual([]);
    });
});

describe("the composer's requests", () => {
    it("are fetches, not server actions", async () => {
        const composer = await readFile(`${MAIL}composer.tsx`, "utf8");
        expect(composer).toContain("outbox.saveDraft(fields, id)");
        expect(composer).toContain("outbox.queueMessage({");
        expect(composer).toContain("outbox.undoSend(draftId)");
        expect(composer).toContain("outbox.sendNow(draftId)");
        const outbox = await readFile(`${MAIL}outbox.ts`, "utf8");
        expect(outbox).toContain('"/api/mail/drafts"');
        expect(outbox).toContain('"/api/mail/outbox"');
        expect(outbox).toContain("await fetch(url");
    });

    it("have no second path through the router", async () => {
        const actions = await readFile(`${MAIL}actions.ts`, "utf8");
        for (const gone of ["saveDraftAction", "sendAction", "undoSendAction"]) {
            expect(actions, gone).not.toContain(`export async function ${gone}(`);
        }
    });

    it("never redraw Mail's frame for a message sent", async () => {
        for (const route of ["drafts/route.ts", "outbox/route.ts", "outbox/[draftId]/route.ts"]) {
            const source = await readFile(`${SRC}app/api/mail/${route}`, "utf8");
            expect(source, route).not.toContain("revalidatePath");
            expect(source, route).toContain('apiPermission("mail.use")');
        }
    });
});
