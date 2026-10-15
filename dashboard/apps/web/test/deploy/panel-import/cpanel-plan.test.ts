import { describe, expect, it } from "vitest";
import {
    BackupRefusal,
    checkListing,
    entryNameProblem,
    listingProblem,
    parseKeyValues,
    planFrom,
    relativeDocumentRoot
} from "@/lib/deploy/panel-import/cpanel";

const file = (path: string, bytes = 10) => `-rw-r--r-- user/user ${bytes} 2026-01-01 00:00 ${path}`;

describe("cPanel backup listing", () => {
    it("takes plain files and folders", () => {
        const listing = ["drwxr-xr-x user/user 0 2026-01-01 00:00 backup/", file("backup/homedir/public_html/index.php")].join("\n");
        expect(checkListing(listing)).toEqual({ entries: 2, bytes: 10 });
    });

    it("refuses links, parent steps and absolute paths", () => {
        expect(listingProblem("lrwxrwxrwx user/user 0 2026-01-01 00:00 backup/x -> /etc/passwd")).toMatch(/links/);
        expect(listingProblem("hrw-r--r-- user/user 0 2026-01-01 00:00 backup/x link to y")).toMatch(/links/);
        expect(listingProblem(file("backup/../../etc/cron.d/x"))).toMatch(/leaves/);
        expect(listingProblem(file("/etc/passwd"))).toMatch(/absolute/);
        expect(entryNameProblem("C:/Windows/x")).toMatch(/absolute/);
        expect(() => checkListing(file("a/../../b"))).toThrow(BackupRefusal);
    });

    it("refuses a backup that unpacks past the cap, and an empty one", () => {
        expect(() => checkListing(file("big", 21 * 1024 ** 3))).toThrow(/unpacks to more/);
        expect(() => checkListing("\n")).toThrow(/empty/);
    });
});

describe("cPanel backup plan", () => {
    it("reads settings files", () => {
        expect(parseKeyValues("---\nmain_domain: example.test\ndocumentroot: '/home/acct/public_html'\n  - nested\n")).toEqual({
            main_domain: "example.test",
            documentroot: "/home/acct/public_html"
        });
    });

    it("turns document roots into paths inside the home, never outside it", () => {
        expect(relativeDocumentRoot("/home/acct/public_html", "acct")).toBe("public_html");
        expect(relativeDocumentRoot("/home2/acct/addon.test/web", "other")).toBe("addon.test/web");
        expect(relativeDocumentRoot("/home/acct/../../etc", "acct")).toBe("public_html");
        expect(relativeDocumentRoot(undefined, "acct")).toBe("public_html");
    });

    it("lists the primary domain first, the databases and what is missing", () => {
        const plan = planFrom({
            account: "acct",
            userdataMain: "main_domain: example.test\n",
            userdata: {
                "addon.test": "documentroot: /home/acct/addon.test\n",
                "example.test": "documentroot: /home/acct/public_html\n",
                "example.test_SSL": "documentroot: /home/acct/public_html\n",
                "cache.json": "{}",
                "not a domain": ""
            },
            dumps: [
                { file: "acct_wp.sql", bytes: 100 },
                { file: "acct_wp.create", bytes: 1 },
                { file: "bad;name.sql", bytes: 1 }
            ],
            hasHome: true
        });
        expect(plan.domains).toEqual([
            { name: "example.test", primary: true, documentRoot: "public_html" },
            { name: "addon.test", primary: false, documentRoot: "addon.test" }
        ]);
        expect(plan.databases).toEqual([{ name: "acct_wp", dump: "mysql/acct_wp.sql", bytes: 100 }]);
        expect(plan.warnings).toEqual([]);
    });

    it("warns when the backup has no domains or no home folder", () => {
        const plan = planFrom({ account: null, userdataMain: null, userdata: {}, dumps: [], hasHome: false });
        expect(plan.warnings).toHaveLength(2);
    });
});
