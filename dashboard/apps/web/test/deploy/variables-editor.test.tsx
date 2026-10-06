// @vitest-environment jsdom

/**
 * A service's variables, worked the way Railway's are: every value can be seen
 * and copied from its row, a secret included; what else can be done to one is
 * behind its menu; the list can be searched; and the raw editor shows the
 * whole set as it is, as a .env or as JSON, to copy or to edit.
 */

import { MessagesWrapper } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ROWS = [
    { id: "v1", key: "DATABASE_URL", isSecret: true, value: null },
    { id: "v2", key: "NODE_ENV", isSecret: false, value: "production" },
    { id: "v3", key: "GOOGLE_CLIENT_ID", isSecret: true, value: null }
];
const SECRETS: Record<string, string> = {
    v1: "postgres://u:p@db:5432/app",
    v3: "1234.apps.googleusercontent.com"
};

const mocks = vi.hoisted(() => ({
    listEnvVarsAction: vi.fn(),
    revealEnvVarAction: vi.fn(),
    revealEnvScopeAction: vi.fn(),
    promoteEnvVarAction: vi.fn(),
    saveEnvVarChangesAction: vi.fn(),
    writeText: vi.fn()
}));

vi.mock("@/app/(app)/apps/deploy/actions", () => ({
    listEnvVarsAction: mocks.listEnvVarsAction,
    revealEnvVarAction: mocks.revealEnvVarAction
}));
vi.mock("@/app/(app)/apps/deploy/variable-actions", () => ({
    variableLinksAction: async () => ({}),
    redeployEnvScopeAction: async () => ({}),
    saveEnvVarChangesAction: mocks.saveEnvVarChangesAction,
    revealEnvScopeAction: mocks.revealEnvScopeAction,
    promoteEnvVarAction: mocks.promoteEnvVarAction
}));

const { VariablesEditor } = await import("@/app/(app)/apps/deploy/variables-editor");

beforeAll(() => {
    Object.assign(Element.prototype, {
        hasPointerCapture: () => false,
        setPointerCapture: () => undefined,
        releasePointerCapture: () => undefined,
        scrollIntoView: () => undefined
    });
});

beforeEach(() => {
    vi.clearAllMocks();
    mocks.listEnvVarsAction.mockResolvedValue(ROWS);
    mocks.revealEnvVarAction.mockImplementation(async (id: string) => ({ value: SECRETS[id] }));
    mocks.revealEnvScopeAction.mockResolvedValue({ values: { ...SECRETS, v2: "production" } });
    mocks.promoteEnvVarAction.mockResolvedValue({ key: "DATABASE_URL" });
    mocks.saveEnvVarChangesAction.mockResolvedValue({ saved: 1, redeployed: false });
    mocks.writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
        value: { writeText: mocks.writeText },
        configurable: true
    });
});

afterEach(() => cleanup());

function open(props: { canWrite?: boolean; onConfigureShared?: () => void } = {}) {
    return render(
        <VariablesEditor
            scope="application"
            scopeId="app-1"
            canWrite={props.canWrite ?? true}
            canDeploy
            redeployTarget="this service"
            onConfigureShared={props.onConfigureShared}
        />,
        { wrapper: MessagesWrapper }
    );
}

describe("a variable's row", () => {
    it("shows a secret's value on request and copies it, without a switch in the row", async () => {
        open();
        const row = (await screen.findByText("DATABASE_URL")).closest("li")!;
        expect(within(row).queryByRole("switch")).toBeNull();
        expect(row.textContent).not.toContain(SECRETS.v1);

        await userEvent.click(
            within(row).getByRole("button", { name: "Show the value of DATABASE_URL" })
        );
        expect(await within(row).findByText(SECRETS.v1)).toBeTruthy();

        await userEvent.click(
            within(row).getByRole("button", { name: "Copy the value of DATABASE_URL" })
        );
        await waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith(SECRETS.v1));
    });

    it("copies a secret nobody revealed by reading it first", async () => {
        open();
        const row = (await screen.findByText("GOOGLE_CLIENT_ID")).closest("li")!;
        await userEvent.click(
            within(row).getByRole("button", { name: "Copy the value of GOOGLE_CLIENT_ID" })
        );
        await waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith(SECRETS.v3));
        expect(mocks.revealEnvVarAction).toHaveBeenCalledWith("v3");
    });

    it("lets somebody who cannot edit still see and copy a value", async () => {
        open({ canWrite: false });
        const row = (await screen.findByText("DATABASE_URL")).closest("li")!;
        await userEvent.click(
            within(row).getByRole("button", { name: "Show the value of DATABASE_URL" })
        );
        expect(await within(row).findByText(SECRETS.v1)).toBeTruthy();
        expect(within(row).queryByRole("button", { name: "Actions for DATABASE_URL" })).toBeNull();
    });

    it("keeps editing, secrecy, sharing and removing behind its menu", async () => {
        open();
        const row = (await screen.findByText("NODE_ENV")).closest("li")!;
        await userEvent.click(within(row).getByRole("button", { name: "Actions for NODE_ENV" }));
        for (const name of ["Edit", "Make it a secret", "Share with every service", "Remove"]) {
            expect(await screen.findByRole("menuitem", { name })).toBeTruthy();
        }
        await userEvent.click(screen.getByRole("menuitem", { name: "Make it a secret" }));
        expect(await screen.findByText("1 unsaved change")).toBeTruthy();
    });

    it("shares a service's variable with every service, through the server", async () => {
        open();
        const row = (await screen.findByText("DATABASE_URL")).closest("li")!;
        await userEvent.click(
            within(row).getByRole("button", { name: "Actions for DATABASE_URL" })
        );
        await userEvent.click(
            await screen.findByRole("menuitem", { name: "Share with every service" })
        );
        await waitFor(() => expect(mocks.promoteEnvVarAction).toHaveBeenCalledWith({ id: "v1" }));
        expect(mocks.listEnvVarsAction).toHaveBeenCalledTimes(2);
    });
});

describe("editing a value where it is", () => {
    it("opens on a double click, with the value as it is", async () => {
        open();
        const row = (await screen.findByText("DATABASE_URL")).closest("li")!;
        await userEvent.dblClick(within(row).getByTitle(/Double-click or F2/));
        const input = (await within(row).findByRole("textbox", {
            name: "Value of DATABASE_URL"
        })) as HTMLInputElement;
        expect(input.value).toBe(SECRETS.v1);
        expect(document.activeElement).toBe(input);
    });

    it("opens on F2 for the row the pointer is on, or the one picked", async () => {
        open();
        const row = (await screen.findByText("NODE_ENV")).closest("li")!;
        await userEvent.hover(row);
        await userEvent.keyboard("{F2}");
        expect(
            await within(row).findByRole("textbox", { name: "Value of NODE_ENV" })
        ).toBeTruthy();

        const other = screen.getByText("GOOGLE_CLIENT_ID").closest("li")!;
        await userEvent.unhover(row);
        await userEvent.click(within(other).getByText("GOOGLE_CLIENT_ID"));
        await userEvent.keyboard("{F2}");
        expect(
            await within(other).findByRole("textbox", { name: "Value of GOOGLE_CLIENT_ID" })
        ).toBeTruthy();
    });

    it("keeps the change on Enter and puts it back on Escape", async () => {
        open();
        const row = (await screen.findByText("NODE_ENV")).closest("li")!;
        await userEvent.dblClick(within(row).getByTitle(/Double-click or F2/));
        const input = await within(row).findByRole("textbox", { name: "Value of NODE_ENV" });
        await userEvent.clear(input);
        await userEvent.type(input, "development{Enter}");
        expect(await screen.findByText("1 unsaved change")).toBeTruthy();

        await userEvent.dblClick(within(row).getByRole("textbox", { name: "Value of NODE_ENV" }));
        await userEvent.keyboard("{Escape}");
        await waitFor(() =>
            expect(within(row).queryByRole("textbox", { name: "Value of NODE_ENV" })).toBeNull()
        );
        expect(screen.queryByText("1 unsaved change")).toBeNull();
    });

    it("is not offered to somebody who cannot edit", async () => {
        open({ canWrite: false });
        const row = (await screen.findByText("NODE_ENV")).closest("li")!;
        expect(within(row).queryByTitle(/Double-click or F2/)).toBeNull();
        await userEvent.hover(row);
        await userEvent.keyboard("{F2}");
        expect(within(row).queryByRole("textbox")).toBeNull();
    });
});

describe("the list", () => {
    it("is searched by name", async () => {
        open();
        await screen.findByText("DATABASE_URL");
        await userEvent.type(screen.getByRole("searchbox", { name: "Search variables" }), "google");
        expect(screen.queryByText("DATABASE_URL")).toBeNull();
        expect(screen.getByText("GOOGLE_CLIENT_ID")).toBeTruthy();

        await userEvent.clear(screen.getByRole("searchbox", { name: "Search variables" }));
        await userEvent.type(
            screen.getByRole("searchbox", { name: "Search variables" }),
            "nothing-like-it"
        );
        expect(screen.getByText("No variable matches that.")).toBeTruthy();
    });

    it("points at the shared variables, as Railway does", async () => {
        const configure = vi.fn();
        open({ onConfigureShared: configure });
        await screen.findByText("DATABASE_URL");
        expect(screen.getByText("Keep variables in sync across services")).toBeTruthy();
        await userEvent.click(screen.getByRole("button", { name: "Configure shared variables" }));
        expect(configure).toHaveBeenCalled();
    });
});

describe("the raw editor", () => {
    it("shows every value as it is, as a .env or as JSON, and copies it", async () => {
        open();
        await screen.findByText("DATABASE_URL");
        await userEvent.click(screen.getByRole("button", { name: /Raw editor/ }));
        const text = (await screen.findByRole("textbox", {
            name: "Variables as text"
        })) as HTMLTextAreaElement;
        await waitFor(() => expect(text.value).toContain(`DATABASE_URL="${SECRETS.v1}"`));
        expect(text.value).toContain('NODE_ENV="production"');

        await userEvent.click(screen.getByRole("radio", { name: "JSON" }));
        await waitFor(() =>
            expect(JSON.parse(text.value)).toMatchObject({ GOOGLE_CLIENT_ID: SECRETS.v3 })
        );

        await userEvent.click(screen.getByRole("button", { name: "Copy all" }));
        await waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith(text.value));
    });

    it("stages what was typed as the whole new set, for review before it is saved", async () => {
        open();
        await screen.findByText("DATABASE_URL");
        await userEvent.click(screen.getByRole("button", { name: /Raw editor/ }));
        const text = (await screen.findByRole("textbox", {
            name: "Variables as text"
        })) as HTMLTextAreaElement;
        await waitFor(() => expect(text.value).toContain("NODE_ENV"));
        await userEvent.clear(text);
        await userEvent.type(text, `DATABASE_URL="${SECRETS.v1}"{enter}NODE_ENV="development"`);
        await userEvent.click(screen.getByRole("button", { name: "Update variables" }));
        // One value changed and GOOGLE_CLIENT_ID left out.
        expect(await screen.findByText("2 unsaved changes")).toBeTruthy();
        expect(mocks.saveEnvVarChangesAction).not.toHaveBeenCalled();
    });

    it("says what is wrong with JSON instead of staging half of it", async () => {
        open();
        await screen.findByText("DATABASE_URL");
        await userEvent.click(screen.getByRole("button", { name: /Raw editor/ }));
        await userEvent.click(await screen.findByRole("radio", { name: "JSON" }));
        const text = screen.getByRole("textbox", { name: "Variables as text" });
        await userEvent.clear(text);
        await userEvent.type(text, '{{"PORT": 3000}');
        await userEvent.click(screen.getByRole("button", { name: "Update variables" }));
        expect(await screen.findByText(/PORT has to be text/)).toBeTruthy();
    });

    it("paints the text the way a code editor does", async () => {
        open();
        await screen.findByText("DATABASE_URL");
        await userEvent.click(screen.getByRole("button", { name: /Raw editor/ }));
        const dialog = await screen.findByRole("dialog");
        await waitFor(() => expect(dialog.querySelector("[class^='hljs-']")).not.toBeNull());
    });

    it("has a copy icon, and downloads the set as the file it is", async () => {
        const created: Blob[] = [];
        const saved: string[] = [];
        Object.assign(URL, {
            createObjectURL: (blob: Blob) => {
                created.push(blob);
                return "blob:variables";
            },
            revokeObjectURL: () => undefined
        });
        const click = vi
            .spyOn(HTMLAnchorElement.prototype, "click")
            .mockImplementation(function (this: HTMLAnchorElement) {
                saved.push(this.download);
            });
        open();
        await screen.findByText("DATABASE_URL");
        await userEvent.click(screen.getByRole("button", { name: /Raw editor/ }));
        const text = (await screen.findByRole("textbox", {
            name: "Variables as text"
        })) as HTMLTextAreaElement;
        await waitFor(() => expect(text.value).toContain("NODE_ENV"));
        expect(screen.getByRole("button", { name: "Copy all" }).querySelector("svg")).not.toBeNull();

        await userEvent.click(screen.getByRole("button", { name: "Download" }));
        expect(saved).toEqual([".env"]);
        expect(await created[0]!.text()).toBe(text.value);

        await userEvent.click(screen.getByRole("radio", { name: "JSON" }));
        await userEvent.click(screen.getByRole("button", { name: "Download" }));
        expect(saved[1]).toBe("variables.json");
        click.mockRestore();
    });

    it("finds a run of text in it, on Ctrl+F or its button", async () => {
        open();
        await screen.findByText("DATABASE_URL");
        await userEvent.click(screen.getByRole("button", { name: /Raw editor/ }));
        const text = (await screen.findByRole("textbox", {
            name: "Variables as text"
        })) as HTMLTextAreaElement;
        await waitFor(() => expect(text.value).toContain("NODE_ENV"));
        await userEvent.click(screen.getByRole("button", { name: "Find in the variables" }));
        const find = screen.getByRole("textbox", { name: "Find in the variables" });
        await userEvent.type(find, "node_env");
        expect(await screen.findByText("1 of 1")).toBeTruthy();
        await userEvent.keyboard("{Escape}");
        await waitFor(() =>
            expect(screen.queryByRole("textbox", { name: "Find in the variables" })).toBeNull()
        );

        text.focus();
        await userEvent.keyboard("{Control>}f{/Control}");
        expect(await screen.findByRole("textbox", { name: "Find in the variables" })).toBeTruthy();
    });

    it("is read-only for somebody who cannot edit, and still copies", async () => {
        open({ canWrite: false });
        await screen.findByText("DATABASE_URL");
        await userEvent.click(screen.getByRole("button", { name: /Raw editor/ }));
        const text = (await screen.findByRole("textbox", {
            name: "Variables as text"
        })) as HTMLTextAreaElement;
        expect(text.readOnly).toBe(true);
        expect(screen.queryByRole("button", { name: "Update variables" })).toBeNull();
        expect(screen.getByRole("button", { name: "Copy all" })).toBeTruthy();
    });
});
