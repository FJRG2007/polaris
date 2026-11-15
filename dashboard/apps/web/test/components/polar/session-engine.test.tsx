// @vitest-environment jsdom

/**
 * The session engine: the setting on Polar's settings, saved at once and put
 * back when the server refuses it, and the composer's override for one task.
 * Polaris native is listed but disabled, with the reason, until its runtime is
 * ready; tools that cannot take the model say so.
 */

import { MessagesWrapper } from "../../setup/i18n";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { AUTO_ENGINE, NATIVE_ENGINE } from "@/lib/polar/native/engine-choice";
import { CodeEnginePill, SessionEngineSettings, settingOptions } from "@/components/polar/session-engine";

const patches: unknown[] = [];
let refuse = false;

beforeEach(() => {
    patches.length = 0;
    refuse = false;
    vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) => {
            patches.push(JSON.parse(String(init?.body)));
            return new Response("{}", { status: refuse ? 500 : 200 });
        })
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("settingOptions", () => {
    it("lists Automatic, native disabled until ready, then the person's tools", () => {
        expect(settingOptions(["claude", "opencode"], null)).toEqual([
            { id: AUTO_ENGINE, disabled: null },
            { id: NATIVE_ENGINE, disabled: "notReady" },
            { id: "claude", disabled: null },
            { id: "opencode", disabled: null }
        ]);
        expect(settingOptions([], null, true)[1]).toEqual({ id: NATIVE_ENGINE, disabled: null });
    });

    it("keeps a stored tool that is no longer set up, marked as such", () => {
        expect(settingOptions(["claude"], "codex").at(-1)).toEqual({ id: "codex", disabled: "notInstalled" });
        expect(settingOptions(["claude"], NATIVE_ENGINE)).toHaveLength(3);
    });
});

describe("Session engine setting", () => {
    it("shows Automatic by default and saves a tool as soon as it is picked", async () => {
        const user = userEvent.setup();
        render(<SessionEngineSettings tools={["claude", "opencode"]} initial={null} readOnly={false} />, {
            wrapper: MessagesWrapper
        });
        const trigger = screen.getByRole("button", { name: "Engine" });
        expect(trigger.textContent).toContain("Automatic");
        await user.click(trigger);
        const native = await screen.findByRole("menuitem", { name: /Polaris native/ });
        expect(native.getAttribute("aria-disabled")).toBe("true");
        expect(native.textContent).toContain("Not available yet");
        await user.click(screen.getByRole("menuitem", { name: /OpenCode/ }));
        await waitFor(() => expect(patches).toEqual([{ sessionEngine: "opencode" }]));
        expect(screen.getByRole("button", { name: "Engine" }).textContent).toContain("OpenCode");
    });

    it("stores Automatic as null, and puts the old pick back when saving fails", async () => {
        const user = userEvent.setup();
        refuse = true;
        render(<SessionEngineSettings tools={["claude"]} initial="claude" readOnly={false} />, {
            wrapper: MessagesWrapper
        });
        await user.click(screen.getByRole("button", { name: "Engine" }));
        await user.click(await screen.findByRole("menuitem", { name: /Automatic/ }));
        await waitFor(() => expect(patches).toEqual([{ sessionEngine: null }]));
        await waitFor(() => expect(screen.getByRole("button", { name: "Engine" }).textContent).toContain("Claude"));
    });

    it("does not save a pick that is already the setting", async () => {
        const user = userEvent.setup();
        render(<SessionEngineSettings tools={["claude"]} initial={null} readOnly={false} />, {
            wrapper: MessagesWrapper
        });
        await user.click(screen.getByRole("button", { name: "Engine" }));
        await user.click(await screen.findByRole("menuitem", { name: /Automatic/ }));
        expect(patches).toEqual([]);
    });
});

describe("Composer engine override", () => {
    const apiKey = { key: "account:a1", kind: "apiKey" as const, engines: ["claude", "opencode"] };

    it("follows the setting by default, and lists native and unfit tools disabled with why", async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<CodeEnginePill source={apiKey} value={null} onChange={onChange} disabled={false} />, {
            wrapper: MessagesWrapper
        });
        const trigger = screen.getByRole("button", { name: /Engine/ });
        expect(trigger.textContent).toContain("Your setting");
        await user.click(trigger);
        const native = await screen.findByRole("menuitem", { name: /Polaris native/ });
        expect(native.getAttribute("aria-disabled")).toBe("true");
        expect(native.textContent).toContain("Not available yet");
        await user.click(screen.getByRole("menuitem", { name: /OpenCode/ }));
        expect(onChange).toHaveBeenCalledWith("opencode");
    });

    it("names a subscription's other tools as unable to run it", async () => {
        const user = userEvent.setup();
        const plan = { key: "account:p1", kind: "subscription" as const, engines: ["claude"] };
        render(<CodeEnginePill source={plan} value={null} onChange={vi.fn()} disabled={false} />, {
            wrapper: MessagesWrapper
        });
        await user.click(screen.getByRole("button", { name: /Engine/ }));
        const opencode = await screen.findByRole("menuitem", { name: /OpenCode/ });
        expect(opencode.getAttribute("aria-disabled")).toBe("true");
        expect(opencode.textContent).toContain("Can't run this model");
        expect(screen.queryByRole("menuitem", { name: /Gemini/ })).toBeNull();
    });
});
