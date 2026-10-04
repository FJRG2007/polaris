// @vitest-environment jsdom

/**
 * A diagram opens.
 *
 * The report: opening any diagram in Office showed the error page with React's
 * "Maximum update depth exceeded" (#185), on a new diagram and an old one, in
 * either theme. The canvas was never the cause. The diagram is the one editor
 * that registers a browser-side exporter with the chrome above it, and the
 * registration effect depended on the whole slot - which is rebuilt every time
 * an exporter is stored. Registering stored one, which rebuilt the slot, which
 * re-ran the effect: its cleanup stored null, its body stored a fresh function,
 * and round it went until React gave up.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
    OfficeExportProvider,
    useBrowserExporter,
    useRegisterExporter,
    type BrowserExporter
} from "@/app/(app)/office/export-slot";

afterEach(cleanup);

function Editor({ exporter }: { exporter: BrowserExporter }) {
    useRegisterExporter(exporter);
    return null;
}

let seen: BrowserExporter | null = null;

function Menu() {
    seen = useBrowserExporter();
    return <p>{seen ? "can export" : "cannot export"}</p>;
}

describe("the browser exporter slot", () => {
    it("registers an editor's exporter once, without looping", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const blob = new Blob(["x"]);
        render(
            <OfficeExportProvider>
                <Menu />
                <Editor exporter={async () => blob} />
            </OfficeExportProvider>
        );
        expect(await screen.findByText("can export")).toBeTruthy();
        expect(await seen?.("png")).toBe(blob);
        expect(error).not.toHaveBeenCalled();
        error.mockRestore();
    });

    it("calls the newest exporter an editor rendered, without re-registering", async () => {
        const first = new Blob(["1"]);
        const second = new Blob(["2"]);
        const { rerender } = render(
            <OfficeExportProvider>
                <Menu />
                <Editor exporter={async () => first} />
            </OfficeExportProvider>
        );
        const registered = seen;
        rerender(
            <OfficeExportProvider>
                <Menu />
                <Editor exporter={async () => second} />
            </OfficeExportProvider>
        );
        expect(seen).toBe(registered);
        expect(await seen?.("png")).toBe(second);
    });

    it("unregisters when the editor goes away", async () => {
        const { rerender } = render(
            <OfficeExportProvider>
                <Menu />
                <Editor exporter={async () => null} />
            </OfficeExportProvider>
        );
        expect(await screen.findByText("can export")).toBeTruthy();
        await act(async () => {
            rerender(
                <OfficeExportProvider>
                    <Menu />
                </OfficeExportProvider>
            );
        });
        expect(screen.getByText("cannot export")).toBeTruthy();
    });
});
