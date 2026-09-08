/**
 * Polaris' own opinion of arriving mail, and how it learns one.
 *
 * The deciding is pure and lives in `@polaris/core` - given a message and a few
 * numbers it answers with a score and its reasons, and touches nothing. This is
 * the half that reads those numbers out of the database, writes the verdict onto
 * the row, and moves the message when the verdict is strong enough. Which also
 * makes it the half that can lose somebody's mail, so it is deliberately narrow:
 * it runs on arrival in the inbox and nowhere else, once per message, and every
 * path through it that is unsure delivers.
 *
 * **It runs after the rules.** A message somebody's own filter has already sent
 * to Junk, Trash or a folder is not judged at all - their rule is a decision
 * they made, and a second opinion about it would at best agree. That is also why
 * a blocked sender never reaches here: blocking writes a rule.
 *
 * **Learning is only ever explicit.** Pressing Junk teaches junk, pressing Not
 * junk teaches the opposite, and the filter's own verdicts teach nothing. A
 * classifier trained on its own output converges on believing whatever it
 * happened to think first, which for a spam filter means quietly deciding that a
 * supplier is junk and never being contradicted.
 *
 * Every count is per mailbox. A word that means junk in a personal mailbox is
 * often the subject matter of a work one.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { addressesFrom } from "./json";
import { findFolderForRole } from "./folder-roles";

/** What a message needs to say about itself to be judged. Everything is already
 *  on the row: no body is fetched, so this costs one read. */
const JUDGE_SELECT = {
    id: true,
    accountId: true,
    folderId: true,
    messageId: true,
    subject: true,
    snippet: true,
    bodyText: true,
    bodyHtml: true,
    listId: true,
    hasAttachments: true,
    fromJson: true,
    toJson: true,
    replyToJson: true,
    headers: true,
    attachments: { select: { name: true }, take: 20 }
} as const;

type JudgeRow = {
    id: string;
    accountId: string;
    folderId: string;
    messageId: string;
    subject: string;
    snippet: string;
    bodyText: string | null;
    bodyHtml: string | null;
    listId: string;
    hasAttachments: boolean;
    fromJson: unknown;
    toJson: unknown;
    replyToJson: unknown;
    headers: unknown;
    attachments: { name: string }[];
};

/** The row, in the shape the pure judge reads. */
function judgeable(row: JudgeRow): core.JudgeableMessage {
    const from = addressesFrom(row.fromJson)[0];
    const replyTo = addressesFrom(row.replyToJson)[0];
    return {
        subject: row.subject,
        fromAddress: from?.address ?? "",
        fromName: from?.name ?? "",
        replyToAddress: replyTo?.address ?? "",
        toAddresses: addressesFrom(row.toJson).map((one) => one.address),
        snippet: row.snippet,
        bodyText: row.bodyText ?? "",
        bodyHtml: row.bodyHtml ?? "",
        listId: row.listId,
        hasAttachments: row.hasAttachments,
        attachmentNames: row.attachments.map((one) => one.name),
        headers: readHeaders(row.headers)
    };
}

function readHeaders(value: unknown): Record<string, string> | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const out: Record<string, string> = {};
    for (const [key, held] of Object.entries(value as Record<string, unknown>)) {
        if (typeof held === "string") out[key.toLowerCase()] = held;
    }
    return Object.keys(out).length > 0 ? out : null;
}

/** The three identities one message is remembered by. */
function identitiesOf(
    message: core.JudgeableMessage,
    fingerprint: string
): { kind: core.SpamReputation["kind"]; key: string }[] {
    const sender = message.fromAddress.toLowerCase();
    const domain = core.domainOf(sender);
    const found: { kind: core.SpamReputation["kind"]; key: string }[] = [];
    if (sender) found.push({ kind: "sender", key: sender });
    if (domain) found.push({ kind: "domain", key: domain });
    found.push({ kind: "fingerprint", key: fingerprint });
    return found;
}

/**
 * What this mailbox already knows, read in one pass.
 *
 * Four small indexed reads. Worth saying out loud because this runs on every
 * arriving message and a filter that costs a second per message is a filter that
 * makes syncing feel broken.
 */
async function knowledgeFor(
    accountId: string,
    message: core.JudgeableMessage,
    fingerprint: string
): Promise<core.SpamKnowledge> {
    const sender = message.fromAddress.toLowerCase();
    const identities = identitiesOf(message, fingerprint);
    const tokens = core.tokensOf(message);

    const [contact, trusted, reputationRows, tokenRows, totals] = await Promise.all([
        sender
            ? prisma.mailContact.findUnique({
                  where: { accountId_address: { accountId, address: sender } },
                  select: { sentCount: true, receivedCount: true }
              })
            : Promise.resolve(null),
        sender
            ? prisma.mailTrustedSender.findUnique({
                  where: { accountId_address: { accountId, address: sender } },
                  select: { id: true }
              })
            : Promise.resolve(null),
        prisma.mailSpamReputation.findMany({
            where: { accountId, OR: identities.map((one) => ({ kind: one.kind, key: one.key })) },
            select: { kind: true, junkCount: true, goodCount: true }
        }),
        tokens.length > 0
            ? prisma.mailSpamToken.findMany({
                  where: { accountId, token: { in: tokens } },
                  select: { token: true, junkCount: true, goodCount: true }
              })
            : Promise.resolve([]),
        prisma.mailSpamFeedback.groupBy({
            by: ["verdict"],
            where: { accountId },
            _count: { _all: true }
        })
    ]);

    const counts = new Map<string, core.TokenCounts>(tokenRows.map((row) => [row.token, row]));
    const taught = {
        junkMessages: totals.find((row) => row.verdict === "junk")?._count._all ?? 0,
        goodMessages: totals.find((row) => row.verdict === "good")?._count._all ?? 0
    };

    return {
        // Having written to somebody is the strongest thing a client knows about
        // them, and it is knowledge no provider-side filter has.
        writtenTo: (contact?.sentCount ?? 0) > 0,
        // Trusting a sender is an explicit act - it is what turns their pictures
        // on - so it counts. Merely having received mail from them does not:
        // Polaris collects contacts by observing, so every sender of junk would
        // otherwise be in the address book by the second message.
        knownContact: Boolean(trusted),
        // Blocking writes a rule, and rules run first: nothing blocked reaches
        // this. Kept in the shape the judge takes because the judge is general.
        blocked: false,
        reputation: reputationRows.map((row) => ({
            kind: row.kind as core.SpamReputation["kind"],
            junkCount: row.junkCount,
            goodCount: row.goodCount
        })),
        contentScore: core.contentScore(tokens, counts, taught)
    };
}

/**
 * Judge one message, write down what was decided, and file it if the answer was
 * strong enough.
 *
 * Never throws. This runs inside a sync, and a filter that fails must fail as a
 * message nobody judged rather than as a folder that stopped syncing.
 */
export async function judgeArrival(accountId: string, messageId: string): Promise<void> {
    try {
        const account = await prisma.mailAccount.findUnique({
            where: { id: accountId },
            select: { spamFilter: true, userId: true }
        });
        if (!account?.spamFilter) return;

        const row = (await prisma.mailMessage.findUnique({
            where: { id: messageId },
            select: JUDGE_SELECT
        })) as JudgeRow | null;
        if (!row) return;

        const message = judgeable(row);
        const fingerprint = core.spamFingerprint(message);
        const judged = core.judgeSpam(message, await knowledgeFor(accountId, message, fingerprint));

        await prisma.mailMessage.update({
            where: { id: row.id },
            data: { spamScore: judged.score, spamReason: judged.reason }
        });
        if (judged.verdict !== "junk") return;

        // Filed, and only when this mailbox has somewhere to file it. A server
        // with no Junk folder is a mailbox where the answer is to say so on the
        // message rather than to invent a folder or to throw the message away.
        const junk = await findFolderForRole(accountId, "junk");
        if (!junk || junk.id === row.folderId) return;

        // Through the ordinary action, so the mail server is told and the row is
        // dropped for the next pass to pick up under the uid the destination
        // gave it. Rewriting `folderId` here instead left the message in the
        // inbox on every other client, and left a row filed under Junk carrying
        // the inbox's uid - which is a Not junk that moves somebody else's
        // message. Imported at the call site because that module reads this one
        // back for its teaching, and a cycle resolved at module load is a cycle
        // that breaks on the day somebody reorders an import.
        const { actOnMessages } = await import("./messages");
        // Nothing is taught: this is the filter's own verdict, and a classifier
        // trained on its own output converges on believing whatever it happened
        // to think first. And nothing settles: this runs inside a sync that reads
        // Junk later in the same pass and rebuilds the conversations when the
        // folder is through, so doing either here would be a second connection
        // and five hundred rebuilt conversations for every arriving message.
        await actOnMessages(account.userId, [row.id], "junk", { teach: false, settle: false });
    } catch (caught) {
        // A message nobody judged is a message that arrived, which is the
        // failure this is allowed to have.
        console.error(caught);
    }
}

/* -------------------------------------------------------------------------- */
/* Learning                                                                    */
/* -------------------------------------------------------------------------- */

/** What was counted for one message, so exactly it can be taken back. */
interface Counted {
    readonly tokens: string[];
    readonly identities: { kind: string; key: string }[];
}

function readCounted(value: unknown): Counted {
    if (typeof value !== "object" || value === null) return { tokens: [], identities: [] };
    const held = value as { tokens?: unknown; identities?: unknown };
    return {
        tokens: Array.isArray(held.tokens)
            ? held.tokens.filter((one): one is string => typeof one === "string")
            : [],
        identities: Array.isArray(held.identities)
            ? held.identities.filter(
                  (one): one is { kind: string; key: string } =>
                      typeof one === "object" &&
                      one !== null &&
                      typeof (one as { kind?: unknown }).kind === "string" &&
                      typeof (one as { key?: unknown }).key === "string"
              )
            : []
    };
}

/**
 * Teach the filter what somebody just said about a message.
 *
 * Reversible, which is the whole reason `MailSpamFeedback` exists: without it a
 * mistaken press of Junk is permanent, because pressing Not junk afterwards
 * would add a good count without ever removing the junk one and the mailbox
 * would hold both opinions for ever. So the previous answer is unwound first,
 * against exactly the words and identities it was applied to - not against what
 * the message tokenizes to today, which is not the same thing once a body has
 * been downloaded.
 *
 * Keyed on the Message-Id rather than the row: a message moved to Junk is a new
 * row with a new id, and what was said about it has to survive that.
 */
export async function teachSpam(
    accountId: string,
    messageId: string,
    verdict: "junk" | "good"
): Promise<void> {
    try {
        const row = (await prisma.mailMessage.findUnique({
            where: { id: messageId },
            select: JUDGE_SELECT
        })) as JudgeRow | null;
        if (!row || row.accountId !== accountId) return;

        // A message with no Message-Id cannot be un-taught later, so it is not
        // taught at all. Rare enough to be somebody's broken mail server, and
        // teaching something that can never be corrected is the worse failure.
        const key = row.messageId.trim();
        if (!key) return;

        const message = judgeable(row);
        const fingerprint = core.spamFingerprint(message);
        const tokens = core.tokensOf(message);
        const identities = identitiesOf(message, fingerprint);

        const previous = await prisma.mailSpamFeedback.findUnique({
            where: { accountId_messageKey: { accountId, messageKey: key } },
            select: { verdict: true, counted: true }
        });
        if (previous?.verdict === verdict) return;

        // Taking the previous answer back, and putting this one on, in a handful
        // of statements rather than one per word. A message carries up to four
        // hundred words and a bulk Junk carries a screenful of messages: written
        // one at a time this was thousands of round trips before the mail server
        // was told anything, inside the action the screen is waiting on.
        if (previous) {
            const held = readCounted(previous.counted);
            const was = previous.verdict === "junk" ? "junkCount" : "goodCount";
            await Promise.all([
                held.tokens.length > 0
                    ? prisma.mailSpamToken
                          .updateMany({
                              where: { accountId, token: { in: held.tokens }, [was]: { gt: 0 } },
                              data: { [was]: { decrement: 1 } }
                          })
                          .catch(() => undefined)
                    : Promise.resolve(undefined),
                held.identities.length > 0
                    ? prisma.mailSpamReputation
                          .updateMany({
                              where: {
                                  accountId,
                                  [was]: { gt: 0 },
                                  OR: held.identities.map((identity) => ({
                                      kind: identity.kind,
                                      key: identity.key
                                  }))
                              },
                              data: { [was]: { decrement: 1 } }
                          })
                          .catch(() => undefined)
                    : Promise.resolve(undefined)
            ]);
        }

        const column = verdict === "junk" ? "junkCount" : "goodCount";
        // Created first at nought and counted after, rather than upserted one by
        // one: `skipDuplicates` makes the create a no-op for the words this
        // mailbox already knows, and the increment that follows then covers both
        // in one statement. Two people teaching the same word at once is safe
        // for the same reason - the create is skipped and the increment is the
        // database's.
        if (tokens.length > 0) {
            await prisma.mailSpamToken.createMany({
                data: tokens.map((token) => ({ accountId, token })),
                skipDuplicates: true
            });
            await prisma.mailSpamToken.updateMany({
                where: { accountId, token: { in: tokens } },
                data: { [column]: { increment: 1 } }
            });
        }
        if (identities.length > 0) {
            await prisma.mailSpamReputation.createMany({
                data: identities.map((identity) => ({
                    accountId,
                    kind: identity.kind,
                    key: identity.key
                })),
                skipDuplicates: true
            });
            await prisma.mailSpamReputation.updateMany({
                where: {
                    accountId,
                    OR: identities.map((identity) => ({ kind: identity.kind, key: identity.key }))
                },
                data: { [column]: { increment: 1 } }
            });
        }

        await prisma.mailSpamFeedback.upsert({
            where: { accountId_messageKey: { accountId, messageKey: key } },
            update: { verdict, counted: { tokens, identities } },
            create: { accountId, messageKey: key, verdict, counted: { tokens, identities } }
        });

        // What the message now says about itself. A message somebody fished out
        // of Junk should stop carrying an accusation the moment they say so.
        await prisma.mailMessage.updateMany({
            where: { accountId, messageId: key },
            data:
                verdict === "good"
                    ? { spamScore: 0, spamReason: "" }
                    : { spamScore: 100, spamReason: "You marked this as junk" }
        });
    } catch (caught) {
        // Teaching is a side effect of filing a message. It must never be the
        // reason the filing failed.
        console.error(caught);
    }
}

/** Forget everything one mailbox has been taught. Offered because a filter that
 *  has learned the wrong thing and cannot be reset is one people switch off. */
export async function forgetSpamLearning(accountId: string): Promise<void> {
    await prisma.$transaction([
        prisma.mailSpamToken.deleteMany({ where: { accountId } }),
        prisma.mailSpamReputation.deleteMany({ where: { accountId } }),
        prisma.mailSpamFeedback.deleteMany({ where: { accountId } })
    ]);
}

/** How much this mailbox has been taught, for the settings screen to say. A
 *  filter whose state is invisible is one nobody trusts. */
export async function spamLearning(
    accountId: string
): Promise<{ junk: number; good: number; words: number }> {
    const [totals, words] = await Promise.all([
        prisma.mailSpamFeedback.groupBy({
            by: ["verdict"],
            where: { accountId },
            _count: { _all: true }
        }),
        prisma.mailSpamToken.count({ where: { accountId } })
    ]);
    return {
        junk: totals.find((row) => row.verdict === "junk")?._count._all ?? 0,
        good: totals.find((row) => row.verdict === "good")?._count._all ?? 0,
        words
    };
}
