// @vitest-environment jsdom

/**
 * The one terminal view: a transport gets a sink once xterm is on screen,
 * output written to it reaches the terminal, typing reaches the transport's
 * input unless the view is read-only, and a new transport key tears the old
 * connection down before opening the next.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const terms: FakeTerminal[] = [];

class FakeTerminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    written: (string | Uint8Array)[] = [];
    disposed = false;
    private typed: ((data: string) => void) | null = null;
    buffer = { active: { length: 0, getLine: () => undefined } };
    constructor(options: Record<string, unknown>) {
        this.options = options;
        terms.push(this);
    }
    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    write(data: string | Uint8Array) {
        this.written.push(data);
    }
    onData(listener: (data: string) => void) {
        this.typed = listener;
        return { dispose: () => (this.typed = null) };
    }
    onResize() {
        return { dispose: () => undefined };
    }
    type(data: string) {
        this.typed?.(data);
    }
    focus() {}
    getSelection() {
        return "";
    }
    hasSelection() {
        return false;
    }
    dispose() {
        this.disposed = true;
    }
}

vi.mock("@xterm/xterm", () => ({ Terminal: FakeTerminal }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class {} }));
vi.mock("@/components/polar/polar-panel", () => ({ usePolarOptional: () => null }));
vi.mock("@/lib/use-terminal-layout", () => ({ useTerminalLayout: () => ({ layout: {}, change: vi.fn() }) }));
vi.mock("@/components/i18n/i18n-provider", () => ({
    useTranslations: () => (key: string) => key
}));

const { TerminalView } = await import("@/app/(app)/apps/deploy/terminal-view");
type Transport = import("@/app/(app)/apps/deploy/terminal-view").TerminalTransport;

beforeAll(() => {
    globalThis.ResizeObserver ??= class {
        observe() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;
});

afterEach(() => {
    cleanup();
    terms.length = 0;
});

describe("terminal view", () => {
    it("hands the transport a sink that writes output and carries typing", async () => {
        const sent: string[] = [];
        const stop = vi.fn();
        const transport: Transport = vi.fn((sink) => {
            sink.write("hello");
            sink.input((data) => sent.push(data));
            return stop;
        });
        const { unmount } = render(<TerminalView transport={transport} transportKey="a" label="Shell" status="Connected" />);
        await waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
        const term = terms[0]!;
        expect(term.written).toEqual(["hello"]);
        expect(term.options.disableStdin).toBe(false);
        term.type("ls\r");
        expect(sent).toEqual(["ls\r"]);
        expect(screen.getByRole("button", { name: "terminal.toolbar.showKeys" })).toBeTruthy();
        unmount();
        expect(stop).toHaveBeenCalledTimes(1);
        expect(term.disposed).toBe(true);
    });

    it("drops typing and hides the key row when read-only", async () => {
        const sent: string[] = [];
        const transport: Transport = vi.fn((sink) => {
            sink.input((data) => sent.push(data));
            return () => undefined;
        });
        render(<TerminalView transport={transport} transportKey="a" readOnly />);
        await waitFor(() => expect(transport).toHaveBeenCalled());
        const term = terms[0]!;
        expect(term.options.disableStdin).toBe(true);
        term.type("rm -rf /\r");
        expect(sent).toEqual([]);
        expect(screen.queryByRole("button", { name: "terminal.toolbar.showKeys" })).toBeNull();
        expect(screen.getByRole("button", { name: "terminal.toolbar.find" })).toBeTruthy();
    });

    it("tears the old connection down when the key changes", async () => {
        const stops = [vi.fn(), vi.fn()];
        let calls = 0;
        const transport: Transport = () => stops[calls++]!;
        const { rerender } = render(<TerminalView transport={transport} transportKey="a" />);
        await waitFor(() => expect(calls).toBe(1));
        rerender(<TerminalView transport={transport} transportKey="a" status="Connected" />);
        expect(calls).toBe(1);
        rerender(<TerminalView transport={transport} transportKey="b" />);
        await waitFor(() => expect(calls).toBe(2));
        expect(stops[0]).toHaveBeenCalledTimes(1);
        expect(terms[0]!.disposed).toBe(true);
        expect(stops[1]).not.toHaveBeenCalled();
    });
});
