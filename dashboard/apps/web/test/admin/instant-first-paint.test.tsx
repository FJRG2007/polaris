// @vitest-environment jsdom

/**
 * Admin screens draw before their data.
 *
 * The display defaults and the retention counts used to be awaited by the page,
 * so the navigation held on them and nothing was on screen. The pages now draw
 * their header and hand the read to the browser, which paints the last reading
 * it kept, asks again in the background, and swaps only what moved.
 */

import { join, relative } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const reads = vi.hoisted(() => ({
    platform: vi.fn(async () => {
        throw new Error("the page must not read the display defaults");
    }),
    theme: vi.fn(async () => {
        throw new Error("the page must not read the theme policy");
    }),
    totals: vi.fn(async () => {
        throw new Error("the page must not count the retained tables");
    })
}));

vi.mock("@/lib/session", () => ({
    requireAdmin: vi.fn(async () => ({ id: "admin-1", isAdmin: true }))
}));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: vi.fn(async () => (key: string) => key) }));
vi.mock("@/lib/display-prefs-service", () => ({
    getPlatformDisplayPreferences: reads.platform,
    usersMayChooseTheme: reads.theme
}));
vi.mock("@/lib/retention-service", () => ({
    retentionPolicy: vi.fn(async () => ({ notifications: 30, activity: 90, audit: 0 })),
    retentionTotals: reads.totals
}));
vi.mock("@/lib/setting-store", () => ({ getSetting: vi.fn(async () => null) }));
vi.mock("@/app/(app)/admin/display/actions", () => ({
    savePlatformDisplayAction: vi.fn(async () => ({})),
    setThemePolicyAction: vi.fn(async () => ({}))
}));
vi.mock("@/app/(app)/admin/retention/actions", () => ({
    saveRetentionAction: vi.fn(async () => ({})),
    sweepRetentionAction: vi.fn(async () => ({}))
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { writeSnapshot } from "@/lib/snapshot-cache";
import { AfterPaint } from "@/components/after-paint";
import RetentionPage from "@/app/(app)/admin/retention/page";
import DisplayAdminPage from "@/app/(app)/admin/display/page";
import { RetentionView } from "@/app/(app)/admin/retention/retention-view";
import { DisplayAdminPanel } from "@/app/(app)/admin/display/display-admin-panel";

/** The kept copy of `subject`, wherever the shelf put it. */
function keptValue(subject: string): unknown {
    for (let index = 0; index < sessionStorage.length; index += 1) {
        const key = sessionStorage.key(index)!;
        if (key.endsWith(`:${subject}`)) return JSON.parse(sessionStorage.getItem(key)!).value;
    }
    return undefined;
}

/** Write a kept reading under the key the screen will look for. */
function keep(subject: string, value: unknown): void {
    // The hook prefixes the shelf; outside a provider that is the personal one.
    writeSnapshot(`personal:${subject}`, value);
}

/** A fetch that answers only when the test lets it. */
function heldFetch() {
    let release: (body: unknown) => void = () => undefined;
    const gate = new Promise<unknown>((resolve) => (release = resolve));
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
            const body = await gate;
            return { ok: true, status: 200, json: async () => body } as unknown as Response;
        })
    );
    return { release: (body: unknown) => release(body) };
}

beforeEach(() => sessionStorage.clear());

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("the pages draw without awaiting the data", () => {
    it("display defaults renders its header with no settings read", async () => {
        const page = await DisplayAdminPage();
        expect(page).toBeTruthy();
        expect(reads.platform).not.toHaveBeenCalled();
        expect(reads.theme).not.toHaveBeenCalled();
    });

    it("retention renders without counting the tables", async () => {
        const page = await RetentionPage();
        expect(page).toBeTruthy();
        expect(reads.totals).not.toHaveBeenCalled();
    });
});

describe("the display defaults panel", () => {
    it("shows a skeleton shaped like the cards on a first visit", () => {
        heldFetch();
        render(<DisplayAdminPanel />);
        expect(screen.getByTestId("display-admin-skeleton")).toBeTruthy();
    });

    it("paints the kept reading at once, then swaps in a newer answer", async () => {
        keep("admin.display", { platform: {}, mayChooseTheme: false });
        const fetches = heldFetch();
        render(<DisplayAdminPanel />);

        // No skeleton: the kept reading is on screen before anything answered.
        expect(screen.queryByTestId("display-admin-skeleton")).toBeNull();
        expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");

        await act(async () => fetches.release({ platform: {}, mayChooseTheme: true }));
        await waitFor(() =>
            expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true")
        );
        expect(keptValue("admin.display")).toEqual({ platform: {}, mayChooseTheme: true });
    });

    it("rewrites the kept reading when a change is saved", async () => {
        keep("admin.display", { platform: {}, mayChooseTheme: true });
        const fetches = heldFetch();
        render(<DisplayAdminPanel />);
        await act(async () => fetches.release({ platform: {}, mayChooseTheme: true }));

        await act(async () => fireEvent.click(screen.getByRole("switch")));
        await waitFor(() =>
            expect(keptValue("admin.display")).toEqual({ platform: {}, mayChooseTheme: false })
        );
    });
});

describe("the retention counts", () => {
    const policy = { notifications: 30, activity: 90, audit: 0 } as const;
    const totals = {
        notifications: { total: 1200, due: 40 },
        activity: { total: 5, due: 0 },
        audit: { total: 7, due: 0 }
    };

    it("holds a skeleton line per table until the first count", () => {
        heldFetch();
        const { container } = render(<RetentionView policy={policy} />);
        expect(container.querySelectorAll(".animate-pulse")).toHaveLength(3);
    });

    it("paints the kept counts before the count is asked again", () => {
        keep("admin.retention.totals", totals);
        heldFetch();
        const { container } = render(<RetentionView policy={policy} />);
        expect(container.querySelectorAll(".animate-pulse")).toHaveLength(0);
    });

    it("says the count failed and offers to ask again, instead of a skeleton forever", async () => {
        const fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
        vi.stubGlobal("fetch", fetch);
        const { container } = render(<RetentionView policy={policy} />);

        expect(await screen.findByRole("alert")).toBeTruthy();
        expect(container.querySelectorAll(".animate-pulse")).toHaveLength(0);
        const calls = fetch.mock.calls.length;
        await act(async () => fireEvent.click(screen.getByRole("button", { name: /retry/i })));
        await waitFor(() => expect(fetch.mock.calls.length).toBe(calls + 1));
    });

    it("says the kept counts are old when asking again fails", async () => {
        keep("admin.retention.totals", totals);
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }))
        );
        const { container } = render(<RetentionView policy={policy} />);

        expect((await screen.findByRole("alert")).textContent).toMatch(/stale/i);
        expect(container.querySelectorAll(".animate-pulse")).toHaveLength(0);
    });
});
describe("a region read after the paint", () => {
    it("shows its skeleton, then the answer, and keeps it for the next visit", async () => {
        let answer: (value: { name: string }) => void = () => undefined;
        const load = vi.fn(() => new Promise<{ name: string }>((resolve) => (answer = resolve)));
        render(
            <AfterPaint cacheKey="test.region" load={load} skeleton={<p>waiting</p>}>
                {(data) => <p>{data.name}</p>}
            </AfterPaint>
        );
        expect(screen.getByText("waiting")).toBeTruthy();
        await act(async () => answer({ name: "Ada" }));
        expect(screen.getByText("Ada")).toBeTruthy();
        expect(keptValue("test.region")).toEqual({ value: { name: "Ada" } });
    });

    it("paints the kept answer before asking again", () => {
        keep("test.kept", { value: { name: "Kept" } });
        render(
            <AfterPaint<{ name: string }>
                cacheKey="test.kept"
                load={() => new Promise(() => undefined)}
                skeleton={<p>waiting</p>}
            >
                {(data) => <p>{data.name}</p>}
            </AfterPaint>
        );
        expect(screen.getByText("Kept")).toBeTruthy();
    });

    it("draws the kept answer inert until this visit's answer lands", async () => {
        keep("test.inert", { value: { name: "Kept" } });
        let answer: (value: { name: string }) => void = () => undefined;
        render(
            <AfterPaint<{ name: string }>
                cacheKey="test.inert"
                load={() => new Promise((resolve) => (answer = resolve))}
                skeleton={null}
            >
                {(data) => <input aria-label="name" defaultValue={data.name} />}
            </AfterPaint>
        );
        expect(screen.getByLabelText("name").closest("[inert]")).not.toBeNull();
        await act(async () => answer({ name: "Live" }));
        const field = screen.getByLabelText("name") as HTMLInputElement;
        expect(field.closest("[inert]")).toBeNull();
        expect(field.value).toBe("Live");
    });

    it("says the first read failed over a kept answer, and keeps that answer inert", async () => {
        keep("test.keptFailed", { value: { name: "Kept" } });
        const load = vi.fn(async (): Promise<{ name: string }> => {
            throw new Error("down");
        });
        render(
            <AfterPaint cacheKey="test.keptFailed" load={load} skeleton={null}>
                {(data) => <button type="button">{data.name}</button>}
            </AfterPaint>
        );
        expect(await screen.findByRole("alert")).toBeTruthy();
        expect(screen.getByText("Kept").closest("[inert]")).not.toBeNull();
        const calls = load.mock.calls.length;
        await act(async () => fireEvent.click(screen.getByRole("button", { name: /retry/i })));
        await waitFor(() => expect(load.mock.calls.length).toBe(calls + 1));
    });

    it("keeps nothing in the tab when told not to", async () => {
        render(
            <AfterPaint
                cacheKey="test.secret"
                load={async () => ({ name: "Grace" })}
                persist={false}
                skeleton={null}
            >
                {(data) => <p>{data.name}</p>}
            </AfterPaint>
        );
        expect(await screen.findByText("Grace")).toBeTruthy();
        expect(keptValue("test.secret")).toBeUndefined();
    });

    it("says it failed and asks again on retry, instead of a skeleton forever", async () => {
        const load = vi.fn(async (): Promise<{ name: string }> => {
            throw new Error("down");
        });
        render(
            <AfterPaint cacheKey="test.failed" load={load} skeleton={<p>waiting</p>}>
                {() => <p>never</p>}
            </AfterPaint>
        );
        expect(await screen.findByRole("alert")).toBeTruthy();
        expect(screen.queryByText("waiting")).toBeNull();
        const calls = load.mock.calls.length;
        await act(async () => fireEvent.click(screen.getByRole("button", { name: /retry/i })));
        await waitFor(() => expect(load.mock.calls.length).toBe(calls + 1));
    });

    it("says the record is gone when the answer is empty", async () => {
        render(
            <AfterPaint cacheKey="test.gone" load={async () => null} skeleton={null}>
                {() => <p>never</p>}
            </AfterPaint>
        );
        expect(await screen.findByText(/notFound/)).toBeTruthy();
    });

    it("asks again when the server page renders anew", async () => {
        const load = vi.fn(async () => ({ name: "Ada" }));
        const view = (revision: number) => (
            <AfterPaint cacheKey="test.revision" load={load} revision={revision} skeleton={null}>
                {(data) => <p>{data.name}</p>}
            </AfterPaint>
        );
        const { rerender } = render(view(1));
        await screen.findByText("Ada");
        const calls = load.mock.calls.length;
        rerender(view(2));
        await waitFor(() => expect(load.mock.calls.length).toBe(calls + 1));
    });
});

/**
 * The rule, over every Management page and layout: the exported component may
 * check who is asking and read its translations, and that is all it awaits.
 * Anything else - a prisma query, a service read - holds the HTML of the whole
 * navigation until it answers, and belongs in a region read after the paint
 * (`AfterPaint`) or streamed behind a `<Suspense>` of its own.
 *
 * Only the body of the default export is read, so an async component a page
 * renders inside `<Suspense>` (the SSO providers) is not counted against it.
 */
describe("no Management page awaits its data before it paints", () => {
    // Run from apps/web, like every suite here; jsdom gives `import.meta.url` no file scheme.
    const ADMIN = join(process.cwd(), "src", "app", "(app)", "admin");

    /** What a page may await: the session check, the request, its strings. */
    const FAST =
        /^(require[A-Z]\w*|getTranslations|getLocale|params|searchParams|headers|cookies)$/;

    /**
     * Pages that still await their data, each with the reason. An entry here is
     * debt, not a pass: convert the page and delete its line.
     */
    const ALLOWED: Record<string, string> = {};

    function files(dir: string): string[] {
        return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) return files(full);
            return /^(page|layout)\.tsx$/.test(entry.name) ? [full] : [];
        });
    }

    /** The index just past the bracket that closes the one at `open`. */
    function closing(code: string, open: number): number {
        const pair = code[open] === "(" ? ")" : "}";
        for (let depth = 0, index = open; index < code.length; index += 1) {
            if (code[index] === code[open]) depth += 1;
            if (code[index] === pair && --depth === 0) return index + 1;
        }
        return code.length;
    }

    /** The body of `export default async function`, comments removed. */
    function defaultBody(source: string): string {
        const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
        const start = code.search(/export default async function/);
        if (start < 0) return "";
        // The parameters can hold braces of their own (a destructured prop and its
        // type), so the body is the first brace after the signature closes.
        const signatureEnd = closing(code, code.indexOf("(", start));
        const open = code.indexOf("{", signatureEnd);
        return code.slice(open, closing(code, open));
    }

    /** The name of every call the body awaits, `Promise.all([...])` opened up. */
    function awaited(body: string): string[] {
        const calls: string[] = [];
        for (const match of body.matchAll(/\bawait\s+([\w.]+)/g)) {
            const callee = match[1].split(".")[0];
            if (match[1] !== "Promise.all") {
                calls.push(callee);
                continue;
            }
            const open = body.indexOf("(", match.index);
            const inner = body.slice(open + 1, closing(body, open) - 1);
            for (const call of inner.matchAll(/(?:^|[[,(\s])([A-Za-z_][\w.]*)\s*\(/g)) {
                calls.push(call[1].split(".")[0]);
            }
        }
        return calls;
    }

    function slowReads(file: string): string[] {
        const body = defaultBody(readFileSync(file, "utf8"));
        const slow = awaited(body).filter((call) => !FAST.test(call));
        if (/\bprisma\./.test(body)) slow.push("prisma");
        return [...new Set(slow)];
    }

    it("awaits only the session, the request and its strings", () => {
        const offenders: string[] = [];
        for (const file of files(ADMIN)) {
            const name = relative(ADMIN, file).replace(/\\/g, "/");
            if (name in ALLOWED) continue;
            const slow = slowReads(file);
            if (slow.length) offenders.push(`${name}: ${slow.join(", ")}`);
        }
        expect(offenders).toEqual([]);
    });

    it("lists no exception that has since been converted", () => {
        for (const name of Object.keys(ALLOWED)) {
            expect(slowReads(join(ADMIN, name)).length, name).toBeGreaterThan(0);
        }
    });

    it("recognizes a page that awaits its data", () => {
        const sample = `export default async function Page({ params }: { params: Promise<{ id: string }> }) {
            await requireAdmin();
            const [t, rows] = await Promise.all([getTranslations("admin"), listRows()]);
            const more = await prisma.row.findMany();
        }`;
        const body = defaultBody(sample);
        expect(awaited(body).filter((call) => !FAST.test(call))).toEqual(["listRows", "prisma"]);
    });
});
