/** A mailto link opens the composer on the Polaris in use, and nothing else. */

import { describe, expect, it } from "vitest";
import { serverPath } from "../../src/main/navigation";
import { mailtoIn, mailtoPath } from "../../src/shared/mailto";

describe("a mailto link", () => {
    it("opens the composer with the whole link for the web app to read", () => {
        const link = "mailto:someone@example.com?subject=Hi%20there&body=A%26B";
        expect(mailtoPath(link)).toBe(`/mail/compose?url=${encodeURIComponent(link)}`);
    });

    it("takes the scheme in any case", () => {
        expect(mailtoPath("MAILTO:someone@example.com")).not.toBeNull();
    });

    it("stays a path on the server in use", () => {
        const path = mailtoPath("mailto:a@example.com?body=\\\\evil//x")!;
        expect(serverPath(path, "https://polaris.example")).toMatch(/^https:\/\/polaris\.example\/mail\/compose\?url=/);
    });

    it("refuses what is not one", () => {
        expect(mailtoPath("https://example.com")).toBeNull();
        expect(mailtoPath("polaris://open?server=x")).toBeNull();
        expect(mailtoPath(42)).toBeNull();
        expect(mailtoPath("mailto:a@example.com\nInjected: yes")).toBeNull();
        expect(mailtoPath(`mailto:${"a".repeat(9000)}@example.com`)).toBeNull();
    });

    it("is found among the arguments Windows starts the app with", () => {
        expect(mailtoIn(["C:\\Polaris\\polaris.exe", "--flag", "mailto:a@example.com"])).toBe(
            `/mail/compose?url=${encodeURIComponent("mailto:a@example.com")}`
        );
        expect(mailtoIn(["C:\\Polaris\\polaris.exe"])).toBeNull();
    });
});
