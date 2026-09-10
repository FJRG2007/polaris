/**
 * The quarter-hourly mail server pass on a Polaris that has not installed the
 * app: one cached lookup, and nothing else - no server list, no report mailbox.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

let installed: boolean;
const sweep = vi.fn(async () => ({ checked: 2, changed: 1 }));
const collect = vi.fn(async () => ({ servers: 2, filed: 3 }));

vi.mock("@/lib/mail-server/app-install", () => ({ mailServerAppInstalled: async () => installed }));
vi.mock("@/lib/mail-server/health", () => ({ sweepMailServers: sweep }));
vi.mock("@/lib/mail-server/dmarc-report", () => ({ collectAllReports: collect }));

const { runMailServerPass } = await import("@/lib/mail-server/scheduled");

beforeEach(() => {
    installed = false;
    sweep.mockClear();
    collect.mockClear();
});

describe("the scheduled mail server pass", () => {
    it("does nothing where the app is not installed", async () => {
        expect(await runMailServerPass()).toEqual({ skipped: "not installed" });
        expect(sweep).not.toHaveBeenCalled();
        expect(collect).not.toHaveBeenCalled();
    });

    it("checks the servers and files reports where it is", async () => {
        installed = true;
        expect(await runMailServerPass()).toEqual({ checked: 2, changed: 1, filed: 3 });
        expect(sweep).toHaveBeenCalledOnce();
        expect(collect).toHaveBeenCalledOnce();
    });

    it("is what the scheduler runs for the mail-server job", () => {
        const jobs = readFileSync(join(process.cwd(), "src/lib/cron/jobs.ts"), "utf8");
        const entry = jobs.slice(jobs.indexOf('key: "mail-server"'));
        expect(entry.slice(0, entry.indexOf("},"))).toContain("run: runMailServerPass");
        // Nothing mail-server specific is run from there any other way.
        expect(jobs).not.toContain("sweepMailServers");
        expect(jobs).not.toContain("collectAllReports");
    });
});
