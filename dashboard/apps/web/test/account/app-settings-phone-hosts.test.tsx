// @vitest-environment jsdom
/**
 * Settings > This app > Hosts in a phone app that manages its servers through
 * the page (`polarisMobile.hostsCall`, `PageHosts.java`).
 *
 * What has to hold: the page draws the phone's list with the desktop app's
 * screen, every change is a call to the app that names the host by its origin,
 * the answer comes back through `__polarisMobileHosts`, and an app without the
 * call keeps its own screen.
 */

import { MessagesWrapper } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));

const { AppSettingsView } = await import("../../src/app/(app)/account/app/[category]/app-settings-view");
const { forgetHostsSnapshot } = await import("../../src/components/this-app/hosts-manager");

const HOME = { origin: "https://polaris.example.test", name: "Home", host: "polaris.example.test", active: true };
const LAB = { origin: "https://lab.example.test", name: null, host: "lab.example.test", active: false };

type Answer = (id: string, json: string) => void;

/** A phone app whose `hostsCall` answers each op as `answers` says, a tick later, the way the app does. */
function phone(answers: Record<string, unknown> = {}) {
    const calls: { op: string; args: Record<string, string> }[] = [];
    const app = {
        platform: () => "android",
        changeServer: vi.fn(),
        appSettings: vi.fn(() => JSON.stringify({ version: "0.1.16", server: HOME.origin, servers: [], actions: [], updates: "check" })),
        hostsCall: vi.fn((id: string, op: string, args: string) => {
            calls.push({ op, args: JSON.parse(args) as Record<string, string> });
            const answer = op in answers ? answers[op] : op === "list" ? { servers: [HOME, LAB], error: null } : { ok: true };
            setTimeout(() => (window as { __polarisMobileHosts?: Answer }).__polarisMobileHosts?.(id, JSON.stringify(answer)), 0);
        })
    };
    (window as { polarisMobile?: unknown }).polarisMobile = app;
    return { app, calls };
}

async function draw() {
    render(
        <MessagesWrapper>
            <AppSettingsView category="hosts" />
        </MessagesWrapper>
    );
    await act(async () => {
        await Promise.resolve();
    });
}

afterEach(() => {
    cleanup();
    forgetHostsSnapshot();
    delete (window as { polarisMobile?: unknown }).polarisMobile;
});

describe("hosts in the phone app", () => {
    it("draws the phone's list with how each answers", async () => {
        const { calls } = phone({ status: "online" });
        await draw();
        expect(await screen.findByText("Home")).toBeTruthy();
        expect(screen.getByText("lab.example.test")).toBeTruthy();
        // Once in the phone line under the name, once in the state column; width hides one.
        expect(screen.getAllByText("In use").length).toBeGreaterThan(0);
        await waitFor(() => expect(calls.filter((call) => call.op === "status")).toHaveLength(2));
        expect(calls.find((call) => call.op === "status")?.args).toEqual({ origin: HOME.origin });
    });

    it("switches to a listed host by its origin", async () => {
        const { calls } = phone();
        await draw();
        await screen.findByText("lab.example.test");
        await userEvent.click(screen.getByRole("button", { name: "Actions for lab.example.test" }));
        await userEvent.click(await screen.findByRole("menuitem", { name: "Use this host" }));
        await waitFor(() => expect(calls.some((call) => call.op === "switch")).toBe(true));
        expect(calls.find((call) => call.op === "switch")?.args).toEqual({ origin: LAB.origin });
    });

    it("takes in a pasted code through the app and reads the list again", async () => {
        const { calls } = phone({ import: { ok: true, added: 1, named: 0, skipped: 0 } });
        await draw();
        await screen.findByText("Home");
        await userEvent.type(screen.getByLabelText("Code"), "polaris-hosts:1:abc");
        await userEvent.click(screen.getByRole("button", { name: "Import" }));
        await waitFor(() => expect(calls.some((call) => call.op === "import")).toBe(true));
        expect(calls.find((call) => call.op === "import")?.args).toEqual({ text: "polaris-hosts:1:abc" });
        // What it added is drawn from the list read again.
        await waitFor(() => expect(calls.filter((call) => call.op === "list").length).toBeGreaterThan(1));
    });

    it("keeps the app's own screen in an app without the call", async () => {
        const { app } = phone();
        delete (app as { hostsCall?: unknown }).hostsCall;
        await draw();
        expect(screen.getByRole("button", { name: "Manage hosts" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Switch" })).toBeNull();
    });
});
