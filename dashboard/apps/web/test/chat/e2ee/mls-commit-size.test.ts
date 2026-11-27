/**
 * Ledger row 12 (large channels), phase 0: what an MLS handshake weighs once
 * the tree is full, measured with the real member (the Node binding of
 * @polaris/core-rs) and the suite chat uses (`MLS_SUITE`).
 *
 * A measurement, not a regular test: it builds groups of hundreds of members,
 * so it runs only when `POLARIS_MLS_MEASURE` lists the sizes to build
 * (`POLARIS_MLS_MEASURE=100,500,1000 npx vitest run test/chat/e2ee/mls-commit-size`).
 * Each size prints one line of byte counts; the run fails when a commit a
 * member sends in steady state (one leaves, one joins) is over what the route
 * takes (`mlsBytes` in `lib/chat/e2ee/schemas.ts`), or when a Welcome or GroupInfo
 * is: past `INLINE_TREE_BYTES` both leave the ratchet tree out, and the tree
 * (reported as `tree`) goes up on its own in `TREE_PART_BYTES` parts.
 * Every joiner fills its blank path as the device does (`fillPath`), and the
 * run also fails when a fill, an add batch or a batch of removals is past it.
 * Vitest may drop console output, so `POLARIS_MLS_OUT=<file>` also appends each
 * line there.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { MLS_SUITE } from "@/lib/chat/e2ee/mls-client";
import { MAX_TREE_PARTS, TREE_PART_BYTES } from "@/lib/chat/e2ee/schemas";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { appendFileSync, existsSync, readdirSync } from "node:fs";

type MlsMemberClass = import("@/lib/chat/e2ee/mls-client").MlsMemberClass;
type MlsMemberLike = import("@/lib/chat/e2ee/mls-client").MlsMemberLike;

const nativeDir = join(dirname(fileURLToPath(import.meta.url)), "../../../../../packages/core-rs/native");
const nativeFile = existsSync(nativeDir) ? readdirSync(nativeDir).find((f) => f.startsWith(`polaris-core.${process.platform}-${process.arch}`)) : undefined;
const sizes = (process.env.POLARIS_MLS_MEASURE ?? "")
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 1);

/** The route takes MLS objects of at most 1 MiB once decoded (`base64Url(1, 1024 * 1024)`). */
const WIRE_LIMIT = 1024 * 1024;
/** `ADD_BATCH` / `REMOVE_BATCH` in `mls-client.ts`. */
const BATCH = 100;
/** `FILL_MIN_MEMBERS` in `mls-client.ts`. */
const FILL_MIN_MEMBERS = 32;
/** Where each `mls-size` line is also appended, when set. */
const outFile = process.env.POLARIS_MLS_OUT;
/** `POLARIS_MLS_SPARSE=1` measures the group as it was before joiners filled their paths (fails past ~880 members). */
const fillPaths = process.env.POLARIS_MLS_SPARSE !== "1";
const encoder = new TextEncoder();

describe.skipIf(!nativeFile || sizes.length === 0)("MLS handshake size with a full tree", () => {
    // The body runs at collection even when skipped, so the binary is loaded only when present.
    const { MlsMember } = (nativeFile ? createRequire(import.meta.url)(join(nativeDir, nativeFile)) : {}) as { MlsMember: MlsMemberClass };
    let made = 0;
    const member = (): MlsMemberLike => {
        made += 1;
        const id = `00000000-0000-4000-8000-${String(made).padStart(12, "0")}/measure-device`;
        return new MlsMember(encoder.encode(id), MLS_SUITE, new Uint8Array(randomBytes(32)));
    };

    for (const size of sizes) {
        it(`a group of ${size}`, () => {
            const groupId = new Uint8Array(randomBytes(16));
            const committer = member();
            committer.createGroup(groupId);

            let keyPackage = 0;
            let lastAdd = { commit: 0, welcome: 0, groupInfo: 0, tree: 0 };
            // What `fillPath` in mls-client.ts does on each joiner: one commit of its own path once
            // its ancestors are blank. Each batch's joiners fill in turn before the next batch; the
            // committer and the batchmates still waiting apply each fill, and a joiner that filled is
            // dropped (nothing after it needs it), which keeps the run to one batch of trees in memory.
            const fills: number[] = [];
            for (let added = 1; added < size; added += BATCH) {
                const joiners = Array.from({ length: Math.min(BATCH, size - added) }, () => member());
                const packages = joiners.map((m) => m.keyPackage());
                keyPackage = packages[0]!.length;
                const out = committer.addMembers(groupId, packages);
                committer.mergePendingCommit(groupId);
                lastAdd = { commit: out.commit.length, welcome: out.welcome?.length ?? 0, groupInfo: out.groupInfo?.length ?? 0, tree: out.ratchetTree?.length ?? 0 };
                if (fillPaths && committer.members(groupId).length >= FILL_MIN_MEMBERS) {
                    for (const joiner of joiners) joiner.joinByWelcome(out.welcome!, out.ratchetTree ?? null);
                    for (const [turn, joiner] of joiners.entries()) {
                        if (joiner.blankPath(groupId) === 0) continue;
                        const fill = joiner.selfUpdate(groupId);
                        joiner.mergePendingCommit(groupId);
                        fills.push(fill.commit.length);
                        committer.process(groupId, fill.commit);
                        for (const waiting of joiners.slice(turn + 1)) waiting.process(groupId, fill.commit);
                    }
                }
            }
            expect(committer.members(groupId)).toHaveLength(size);
            const groupInfo = committer.groupInfo(groupId).length;
            const parts = committer.groupInfoParts(groupId);

            // Steady state: one leaves (a commit with a path), one joins.
            const leaf = committer.members(groupId).find((m) => m.leaf !== committer.ownLeaf(groupId))!.leaf;
            const removeOne = committer.removeMembers(groupId, [leaf]);
            committer.mergePendingCommit(groupId);
            const addOne = committer.addMembers(groupId, [member().keyPackage()]);
            committer.mergePendingCommit(groupId);

            // The worst a send does on its own: a whole batch leaving at once.
            const leaves = committer
                .members(groupId)
                .map((m) => m.leaf)
                .filter((l) => l !== committer.ownLeaf(groupId))
                .slice(0, Math.min(BATCH, size - 2));
            const removeBatch = leaves.length > 0 ? committer.removeMembers(groupId, leaves).commit.length : 0;
            committer.clearPendingCommit(groupId);

            const line = {
                members: size,
                keyPackage,
                addBatchCommit: lastAdd.commit,
                addBatchWelcome: lastAdd.welcome,
                addBatchGroupInfo: lastAdd.groupInfo,
                addBatchTree: lastAdd.tree,
                // With the tree inside (what an older device asks for), and the split an external joiner now gets.
                groupInfo,
                groupInfoBare: parts.groupInfo.length,
                tree: parts.ratchetTree?.length ?? 0,
                treeParts: Math.ceil((parts.ratchetTree?.length ?? 0) / TREE_PART_BYTES),
                removeOneCommit: removeOne.commit.length,
                addOneCommit: addOne.commit.length,
                addOneWelcome: addOne.welcome?.length ?? 0,
                removeBatchCommit: removeBatch,
                fillPaths,
                fills: fills.length,
                fillCommitMax: fills.length ? Math.max(...fills) : 0,
                fillCommitLast: fills.at(-1) ?? 0,
                wireLimit: WIRE_LIMIT
            };
            console.log(`mls-size ${JSON.stringify(line)}`);
            if (outFile) appendFileSync(outFile, `mls-size ${JSON.stringify(line)}\n`);
            for (const fill of fills) expect(fill).toBeLessThan(WIRE_LIMIT);
            expect(line.removeBatchCommit).toBeLessThan(WIRE_LIMIT);
            expect(line.addBatchCommit).toBeLessThan(WIRE_LIMIT);
            expect(line.removeOneCommit).toBeLessThan(WIRE_LIMIT);
            expect(line.addOneCommit).toBeLessThan(WIRE_LIMIT);
            expect(line.addOneWelcome).toBeLessThan(WIRE_LIMIT);
            expect(line.addBatchWelcome).toBeLessThan(WIRE_LIMIT);
            expect(line.groupInfoBare).toBeLessThan(WIRE_LIMIT);
            expect(line.treeParts).toBeLessThanOrEqual(MAX_TREE_PARTS);
        }, Math.max(600_000, size * 1_200));
    }
});
