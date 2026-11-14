// @vitest-environment jsdom

/**
 * Running a code block.
 *
 * What has to hold: Run appears only where a browser can run the language on
 * its own; the code is handed to a sandboxed frame with an opaque origin, never
 * run on the page; a message counts only when it came from that frame; and a
 * run that does not finish is ended by removing the frame.
 *
 * jsdom runs no Worker and loads no srcdoc, so the frame's side of the
 * conversation is played here by dispatching the messages it would post.
 */

import { MessagesWrapper } from "../setup/i18n";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeBlock } from "@/components/rich-text/code-block";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { parseRunnerMessage, previewDocument, runKindFor, runnerDocument, stripTypes } from "@/lib/code-run";

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe("which blocks can run", () => {
    it("runs JavaScript, TypeScript and Python, and previews a page", () => {
        expect(runKindFor("js")).toBe("javascript");
        expect(runKindFor("JSX")).toBe("javascript");
        expect(runKindFor("ts")).toBe("typescript");
        expect(runKindFor("py")).toBe("python");
        expect(runKindFor("html")).toBe("html");
    });

    it("offers nothing for a language a browser cannot run alone", () => {
        for (const tag of ["sh", "go", "sql", "xml", "svg", "wolfram", "", null]) expect(runKindFor(tag)).toBeNull();
    });

    it("shows the button only where it can run", () => {
        const markup = (fence: string, code = "x") =>
            renderToStaticMarkup(<MessagesWrapper><CodeBlock code={code} language={fence} /></MessagesWrapper>);
        expect(markup("py")).toContain("Run this code");
        expect(markup("ts")).toContain("Run this code");
        expect(markup("html")).toContain("Preview this page");
        expect(markup("sh")).not.toContain("Run this code");
        expect(markup("sh")).not.toContain("Preview this page");
    });
});

describe("the runner frame", () => {
    it("has a policy of its own that keeps JavaScript off the network", () => {
        const doc = runnerDocument("javascript", "https://polaris.example");
        expect(doc).toContain('http-equiv="Content-Security-Policy"');
        expect(doc).toContain("connect-src 'none'");
        expect(doc).toContain('"https://polaris.example"');
    });

    it("lets Python reach only the pinned runtime", () => {
        const doc = runnerDocument("python", "https://polaris.example");
        expect(doc).toContain("connect-src https://cdn.jsdelivr.net;");
        expect(doc).toMatch(/pyodide\/v\d+\.\d+\.\d+\/full\//);
    });

    it("cannot be closed early by what it carries", () => {
        // Only one closing tag: the frame's own.
        expect(runnerDocument("javascript", "https://a.example").match(/<\/script>/g)).toHaveLength(1);
    });

    it("previews a page under a policy that forbids calling out", () => {
        const doc = previewDocument("<p>hi</p>");
        expect(doc.startsWith("<meta")).toBe(true);
        expect(doc).toContain("connect-src 'none'");
        expect(doc.endsWith("<p>hi</p>")).toBe(true);
    });

    it("accepts only the messages it knows", () => {
        expect(parseRunnerMessage({ type: "out", stream: "stdout", text: "a" })).toEqual({ type: "out", stream: "stdout", text: "a" });
        expect(parseRunnerMessage({ type: "out", stream: "html", text: "a" })).toBeNull();
        expect(parseRunnerMessage({ type: "run", code: "x" })).toBeNull();
        expect(parseRunnerMessage("ready")).toBeNull();
        expect(parseRunnerMessage({ type: "done", result: 1 })).toBeNull();
    });

    it("strips TypeScript's types and nothing else", async () => {
        const out = await stripTypes("const n: number = 1;\ninterface A { b: string }\nconsole.log(n as number);");
        expect(out).not.toContain(": number");
        expect(out).not.toContain("interface");
        expect(out).toContain("console.log(n");
    });
});

function mount(code: string, language: string) {
    render(<CodeBlock code={code} language={language} />, { wrapper: MessagesWrapper });
    fireEvent.click(screen.getByRole("button", { name: "Run this code" }));
    const frame = document.querySelector("iframe") as HTMLIFrameElement;
    const window_ = frame.contentWindow!;
    const posted = vi.spyOn(window_, "postMessage").mockImplementation(() => undefined);
    const say = (data: unknown, source: unknown = window_, origin = "null") =>
        act(() => {
            window.dispatchEvent(new MessageEvent("message", { data, source: source as Window, origin }));
        });
    return { frame, posted, say };
}

describe("a run", () => {
    it("hands the code to a sandboxed frame and prints what comes back", async () => {
        const { frame, posted, say } = mount("console.log('hi')", "js");
        expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
        expect(frame.getAttribute("srcdoc")).toContain("Content-Security-Policy");

        await say({ type: "ready" });
        expect(posted).toHaveBeenCalledWith({ type: "run", code: "console.log('hi')" }, "*");

        await say({ type: "started" });
        await say({ type: "out", stream: "stdout", text: "hi" });
        await say({ type: "out", stream: "stderr", text: "boom" });
        expect(screen.getByText("hi")).toBeTruthy();
        expect(screen.getByText("boom").className).toContain("text-danger");

        await say({ type: "done", result: "42" });
        expect(screen.getByText("42")).toBeTruthy();
        expect(document.querySelector("iframe")).toBeNull();
    });

    it("ignores a message from any other window or origin", async () => {
        const { say } = mount("1", "js");
        await say({ type: "out", stream: "stdout", text: "forged" }, window, "null");
        await say({ type: "out", stream: "stdout", text: "forged too" }, document.querySelector("iframe")!.contentWindow, "https://evil.example");
        expect(screen.queryByText("forged")).toBeNull();
        expect(screen.queryByText("forged too")).toBeNull();
    });

    it("is stopped, frame and all, when it runs too long", async () => {
        vi.useFakeTimers();
        const { say } = mount("while (true) {}", "js");
        await say({ type: "ready" });
        await say({ type: "started" });
        await act(async () => {
            vi.advanceTimersByTime(5_000);
        });
        expect(document.querySelector("iframe")).toBeNull();
        expect(screen.getByText(/Stopped after 5 s/)).toBeTruthy();
    });

    it("can be stopped by hand", async () => {
        const { say } = mount("while (true) {}", "py");
        expect(screen.getByText("Loading Python...")).toBeTruthy();
        await say({ type: "started" });
        fireEvent.click(screen.getByRole("button", { name: "Stop the run" }));
        expect(document.querySelector("iframe")).toBeNull();
        expect(screen.getByText("Stopped.")).toBeTruthy();
    });

    it("says so when the code asks for input", async () => {
        const { say } = mount("input()", "py");
        await say({ type: "note", note: "noInput" });
        expect(screen.getByText(/Input is not available here/)).toBeTruthy();
    });
});

describe("a page", () => {
    it("is previewed in a sandboxed frame, not run", () => {
        render(<CodeBlock code="<h1>Hi</h1>" language="html" />, { wrapper: MessagesWrapper });
        fireEvent.click(screen.getByRole("button", { name: "Preview this page" }));
        const frame = document.querySelector("iframe") as HTMLIFrameElement;
        expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
        expect(frame.getAttribute("srcdoc")).toContain("<h1>Hi</h1>");
        fireEvent.click(screen.getByRole("button", { name: "Close the preview" }));
        expect(document.querySelector("iframe")).toBeNull();
    });
});
