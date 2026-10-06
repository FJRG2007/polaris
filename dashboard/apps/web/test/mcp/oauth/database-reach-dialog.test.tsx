// @vitest-environment jsdom

/**
 * Which databases a connected app may reach, in the dialog its permissions
 * are changed in: offered only while it holds a database permission, every
 * database until the person narrows it, saved through its own action without
 * touching the permissions, and listed by name and engine only.
 */

import { MessagesWrapper } from "../../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const actions = vi.hoisted(() => ({
    disconnectAppAction: vi.fn(),
    changeAppScopesAction: vi.fn(),
    setAppDatabasesAction: vi.fn(),
    setAppIpPolicyAction: vi.fn(),
    setAppNetworkExceptionAction: vi.fn()
}));

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/app/(app)/account/assistants/connected-app-actions", () => actions);
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { ConnectedApps } = await import("@/app/(app)/account/assistants/connected-apps");

const SHOP = "0190a5b8-0000-7000-8000-00000000c0de";
const LOGS = "0190a5b8-0000-7000-8000-0000000010f5";

const DATABASES = [
    { id: SHOP, name: "Shop", engine: "postgres", project: null },
    { id: LOGS, name: "Logs", engine: "mysql", project: "Store / production" }
];

function app(scopes: string[], databaseIds: string[] | null = null) {
    return {
        id: "0190a5b8-0000-7000-8000-0000000000a1",
        name: "Claude",
        clientUri: null,
        redirectHost: "claude.ai",
        brand: null,
        scopes: scopes as never,
        requestable: scopes as never,
        offered: scopes as never,
        unrequested: [] as never,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        lastUsedIp: null,
        ipPolicy: { mode: "none" as const, allow: [], deny: [] },
        approvedIp: null,
        lastRefusedAt: null,
        lastRefusedIp: null,
        networkException: {
            allowedCountries: [],
            allowedContinents: [],
            allowedCidrs: [],
            presets: []
        },
        databaseIds
    };
}

function draw(row: ReturnType<typeof app>) {
    render(
        <MessagesWrapper>
            <ConnectedApps apps={[row]} databases={DATABASES} />
        </MessagesWrapper>
    );
    fireEvent.click(screen.getByRole("button", { name: "Change permissions for Claude" }));
}

beforeEach(() => {
    vi.clearAllMocks();
    actions.setAppDatabasesAction.mockImplementation(async (input: { databaseIds: unknown }) => ({
        databaseIds: input.databaseIds
    }));
});

afterEach(cleanup);

describe("the databases an app may reach", () => {
    it("is not asked about for an app with no database permission", () => {
        draw(app(["tasks.read"]));
        expect(screen.queryByText("Databases it may reach")).toBeNull();
    });

    it("says on the row what an app with a database permission reaches", () => {
        render(
            <MessagesWrapper>
                <ConnectedApps apps={[app(["databases.read"], [LOGS])]} databases={DATABASES} />
            </MessagesWrapper>
        );
        expect(screen.getByText("Databases: 1 chosen")).toBeTruthy();
    });

    it("starts at every database, and saves the ones ticked without touching the permissions", async () => {
        draw(app(["databases.read"]));
        expect(screen.getByText("Databases it may reach")).toBeTruthy();
        expect(screen.getByRole("radio", { name: "Every database you can open" })).toHaveProperty(
            "checked",
            true
        );
        const save = screen.getByRole("button", { name: "Save" });
        expect(save).toHaveProperty("disabled", true);

        fireEvent.click(screen.getByRole("radio", { name: "Only the ones I choose" }));
        expect(screen.getByText("Store / production", { exact: false })).toBeTruthy();
        expect(screen.getByText("None chosen: its database tools are refused.")).toBeTruthy();
        fireEvent.click(screen.getByRole("checkbox", { name: /Logs/ }));
        expect(save).toHaveProperty("disabled", false);

        await act(async () => {
            fireEvent.click(save);
        });
        expect(actions.setAppDatabasesAction).toHaveBeenCalledWith({
            id: "0190a5b8-0000-7000-8000-0000000000a1",
            databaseIds: [LOGS]
        });
        expect(actions.changeAppScopesAction).not.toHaveBeenCalled();
    });

    it("puts the row back and says so when the server refuses", async () => {
        actions.setAppDatabasesAction.mockResolvedValue({ error: "Could not change it." });
        draw(app(["databases.read"]));
        fireEvent.click(screen.getByRole("radio", { name: "Only the ones I choose" }));
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Save" }));
        });
        expect(screen.getByRole("alert").textContent).toBe("Could not change it.");
        expect(screen.getByText("Databases: every one you can open")).toBeTruthy();
    });
});
