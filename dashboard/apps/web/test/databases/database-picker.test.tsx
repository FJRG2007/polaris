// @vitest-environment jsdom

/**
 * The database picker at the top of the workbench.
 *
 * A Postgres connection shows every database on its server with the one it
 * names selected, and picking another sends every call that follows to that
 * one - the server checks the name; this pins that the screen asks for it, and
 * goes back to the connection's own when that one is picked again.
 */

import { MessagesWrapper } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const browseCalls: { namespace: string | null; database: string | null | undefined }[] = [];
let serverDatabases: string[] | null = ["analytics", "app", "billing"];
let failOn: string | null = null;

vi.mock("@/app/(app)/apps/databases/actions", () => ({
    browseAction: async (_id: string, namespace: string | null, database?: string | null) => {
        browseCalls.push({ namespace, database });
        if (failOn !== null && database === failOn) {
            return { error: "There is no database by that name on this server." };
        }
        const opened = database ?? "app";
        return {
            shape: "sql",
            namespaces: [{ name: "public", kind: "schema", count: 1 }],
            relations: [{ name: `t_${opened}`, namespace: "public", kind: "table", rows: 3 }],
            namespace: "public",
            databases: serverDatabases,
            database: serverDatabases ? opened : null
        };
    }
}));

const { Workbench } = await import("@/app/(app)/apps/databases/workbench");

beforeAll(() => {
    Object.assign(Element.prototype, {
        hasPointerCapture: () => false,
        setPointerCapture: () => undefined,
        releasePointerCapture: () => undefined,
        scrollIntoView: () => undefined
    });
});

afterEach(() => {
    cleanup();
    browseCalls.length = 0;
    serverDatabases = ["analytics", "app", "billing"];
    failOn = null;
    try {
        window.localStorage.clear();
    } catch {
        // Nothing kept.
    }
});

function open() {
    return render(<Workbench connectionId="conn-1" readOnly={false} />, {
        wrapper: MessagesWrapper
    });
}

describe("the database picker", () => {
    it("lists the server's databases with the configured one selected", async () => {
        open();
        const picker = await screen.findByRole("combobox", { name: "Which database" });
        expect(picker.textContent).toContain("app (default)");
        expect(await screen.findByText("t_app")).toBeTruthy();

        await userEvent.click(picker);
        const options = (await screen.findAllByRole("option")).map((entry) => entry.textContent);
        expect(options).toEqual(["analytics", "app (default)", "billing"]);
    });

    it("opens a picked database and goes back to the connection's own", async () => {
        open();
        await userEvent.click(await screen.findByRole("combobox", { name: "Which database" }));
        await userEvent.click(await screen.findByRole("option", { name: "billing" }));

        expect(await screen.findByText("t_billing")).toBeTruthy();
        expect(browseCalls.at(-1)).toEqual({ namespace: null, database: "billing" });

        await userEvent.click(screen.getByRole("combobox", { name: "Which database" }));
        await userEvent.click(await screen.findByRole("option", { name: "app (default)" }));

        expect(await screen.findByText("t_app")).toBeTruthy();
        expect(browseCalls.at(-1)).toEqual({ namespace: null, database: null });
    });

    it("says why a picked database did not open, and keeps the picker to leave it", async () => {
        failOn = "analytics";
        open();
        await userEvent.click(await screen.findByRole("combobox", { name: "Which database" }));
        await userEvent.click(await screen.findByRole("option", { name: "analytics" }));

        expect((await screen.findByRole("alert")).textContent).toContain(
            "There is no database by that name on this server."
        );
        expect(screen.getByRole("combobox", { name: "Which database" })).toBeTruthy();
    });

    it("draws no picker when the server offers only the one database", async () => {
        serverDatabases = ["app"];
        open();
        expect(await screen.findByText("t_app")).toBeTruthy();
        expect(screen.queryByRole("combobox", { name: "Which database" })).toBeNull();
    });

    it("draws no picker for an engine with no list", async () => {
        serverDatabases = null;
        open();
        expect(await screen.findByText("t_app")).toBeTruthy();
        await waitFor(() =>
            expect(screen.queryByRole("combobox", { name: "Which database" })).toBeNull()
        );
    });
});
