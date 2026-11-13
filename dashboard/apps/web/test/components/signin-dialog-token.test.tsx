// @vitest-environment jsdom

/**
 * Signing Claude in without a terminal.
 *
 * The dialog used to open on the raw terminal, and once the login printed its
 * token it was the person's job to notice, copy it out and paste it into a field
 * whose label said Polaris would not read it for them. Pinned: the two steps
 * show with a field of their own for the code, the terminal stays folded, the
 * code typed there reaches the login, and the token is kept the moment it is on
 * the screen with nothing to copy.
 */

import { withMessages } from "../setup/i18n";
import type { AgentSignin } from "@/lib/agents/agent-signins";
import type { SigninView } from "@/lib/agents/signin-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SigninDialog, type SigninDialogActions } from "@/components/model-keys/signin-dialog";

const TOKEN = `sk-ant-oat01-${"F".repeat(90)}`;

const signin: AgentSignin = {
    env: "CLAUDE_CODE_OAUTH_TOKEN",
    slug: "claude-code-oauth-token",
    label: "Claude subscription token",
    url: "https://example.invalid",
    howto: null,
    subscription: true,
    file: null,
    onScreen: true,
    serves: [{ id: "claude", label: "Claude Code" }]
};

function view(finished: boolean): SigninView {
    return {
        screen: finished ? ` Your OAuth token (valid for 1 year):\n\n ${TOKEN}\n` : " Paste code here if prompted >",
        url: "https://claude.example.invalid/oauth/authorize?code=true",
        code: null,
        signedInAs: null,
        exitCode: finished ? 0 : null,
        finished,
        ready: true,
        flow: "paste",
        rung: "cli",
        fellBack: false
    };
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

async function settle(ms = 0) {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
}

describe("the Claude sign-in dialog", () => {
    it("asks for the code in a field of its own and keeps the token on its own", async () => {
        let done = false;
        const actions: SigninDialogActions = {
            begin: vi.fn(async () => ({ id: "attempt" })),
            screen: vi.fn(async () => ({ view: view(done) })),
            answer: vi.fn(async () => ({})),
            end: vi.fn(async () => ({})),
            identity: vi.fn(async () => ({})),
            capture: vi.fn(async () => (done ? { value: TOKEN } : { error: "not yet" })),
            save: vi.fn(async () => ({}))
        };
        render(withMessages(<SigninDialog signin={signin} actions={actions} onClose={() => {}} onDone={() => {}} />));
        await settle();
        await settle();

        // Folded: nothing to read off a terminal.
        expect(document.querySelector("pre")).toBeNull();
        const field = screen.getByRole("textbox", { name: /code/i });
        fireEvent.change(field, { target: { value: "abc#def" } });
        fireEvent.keyDown(field, { key: "Enter" });
        await settle();
        expect(actions.answer).toHaveBeenCalledWith({ id: "attempt", text: "abc#def" });
        expect(actions.save).not.toHaveBeenCalled();

        done = true;
        await settle(1500);
        await settle();
        await settle();
        expect(actions.save).toHaveBeenCalledWith(TOKEN, {}, expect.any(String));
    });

    it("opens the terminal and the copy field when the token cannot be read", async () => {
        const actions: SigninDialogActions = {
            begin: vi.fn(async () => ({ id: "attempt" })),
            screen: vi.fn(async () => ({ view: view(true) })),
            answer: vi.fn(async () => ({})),
            end: vi.fn(async () => ({})),
            identity: vi.fn(async () => ({})),
            capture: vi.fn(async () => ({ error: "not yet" })),
            save: vi.fn(async () => ({}))
        };
        render(withMessages(<SigninDialog signin={signin} actions={actions} onClose={() => {}} onDone={() => {}} />));
        for (let round = 0; round < 12; round += 1) await settle(1500);
        expect(actions.save).not.toHaveBeenCalled();
        expect(document.querySelector("pre")).not.toBeNull();
        expect(document.querySelector('input[type="password"]')).not.toBeNull();
    });
});
