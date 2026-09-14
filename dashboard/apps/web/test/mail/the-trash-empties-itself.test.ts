/**
 * A trash nobody empties.
 *
 * Every mail service throws away what has been in the bin for thirty days, and
 * for a reason that has nothing to do with tidiness: a trash that is only ever
 * emptied by hand is a second mailbox that grows for ever - on the mail server,
 * where the quota is, and in Polaris' own copy of it. Polaris had no such sweep,
 * so the only way anything left a bin was somebody pressing Empty.
 *
 * Thirty days by default, per mailbox, and changeable to seven, sixty, ninety or
 * "until I empty it" - which is what every mailbox did before this existed, so it
 * stays a real answer rather than becoming a thing nobody can switch off.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { MAIL_TRASH_KEEP_CHOICES, mailAccountEditSchema } from "@polaris/core";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

describe("what a mailbox keeps", () => {
    it("is thirty days unless somebody says otherwise", async () => {
        const schema = await readFile(`${ROOT}packages/db/prisma/schema.prisma`, "utf8");
        expect(schema).toContain("trashKeepDays Int @default(30)");
    });

    it("offers never, and means it", () => {
        expect(MAIL_TRASH_KEEP_CHOICES.map((choice) => choice.days)).toContain(0);
        expect(mailAccountEditSchema.parse({}).trashKeepDays).toBe(30);
        expect(mailAccountEditSchema.parse({ trashKeepDays: 0 }).trashKeepDays).toBe(0);
    });

    it("refuses a window that is not a window", () => {
        expect(mailAccountEditSchema.safeParse({ trashKeepDays: -1 }).success).toBe(false);
        expect(mailAccountEditSchema.safeParse({ trashKeepDays: 400 }).success).toBe(false);
    });
});

describe("the sweep itself", () => {
    const trash = readFile(`${SRC}lib/mailbox/trash.ts`, "utf8");

    it("asks only the mailboxes that asked for it", async () => {
        const source = await trash;
        expect(source).toContain("where: { trashKeepDays: { gt: 0 } }");
    });

    it("lets the server decide what is old, not the window Polaris holds", async () => {
        // The messages old enough to go are exactly the ones outside the few
        // hundred this machine caches, so a scan of the cache would find none of
        // them.
        const source = await trash;
        expect(source).toContain("const old = await client.search({ before }, { uid: true });");
        expect(source).toContain("await client.messageDelete(old, { uid: true });");
    });

    it("drops the rows it deleted rather than waiting for a sync to notice", async () => {
        const source = await trash;
        expect(source).toContain("await prisma.mailMessage.deleteMany({");
        expect(source).toContain("uid: { in: old.map((uid) => BigInt(uid)) }");
    });

    it("does not let one unreachable mailbox stop the rest", async () => {
        const source = await trash;
        const sweep = source.slice(source.indexOf("export async function sweepTrash"));
        expect(sweep.slice(0, sweep.indexOf("return dropped;"))).toContain("continue;");
    });
});

describe("when it runs", () => {
    const jobs = readFile(`${SRC}lib/cron/jobs.ts`, "utf8");

    it("is a daily pass rather than a minute one", async () => {
        const source = await jobs;
        const job = source.slice(source.indexOf('key: "mail-trash"'));
        const body = job.slice(0, job.indexOf("},"));
        expect(body).toContain("everyMs: 24 * HOUR");
        expect(body).toContain("run: sweepTrash");
    });

    it("is leased, because two passes are two IMAP sessions per mailbox", async () => {
        const source = await jobs;
        const job = source.slice(source.indexOf('key: "mail-trash"'));
        expect(job.slice(0, job.indexOf("},"))).toContain("leaseMs: 25 * HOUR");
    });

    it("can be triggered from outside like every other job", async () => {
        const route = await readFile(`${SRC}app/api/cron/mail-trash/route.ts`, "utf8");
        expect(route).toContain('runScheduledJob("mail-trash")');
        expect(route).toContain("authorizeCron(request)");
    });
});

describe("where it is set", () => {
    it("is on the mailbox, beside its other switches", async () => {
        const view = await readFile(
            `${SRC}app/(app)/mail/settings/accounts/accounts-view.tsx`,
            "utf8"
        );
        expect(view).toContain("MAIL_TRASH_KEEP_CHOICES");
        expect(view).toContain("editAccountAction(account.id, {\n                                    trashKeepDays: days\n                                })");
    });

    it("puts the old answer back when the server refuses", async () => {
        const view = await readFile(
            `${SRC}app/(app)/mail/settings/accounts/accounts-view.tsx`,
            "utf8"
        );
        expect(view).toContain("setTrashDays(before);");
    });
});
