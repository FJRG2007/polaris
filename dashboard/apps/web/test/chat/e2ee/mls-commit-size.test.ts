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
 * takes (`mlsBytes` in `lib/chat/e2ee/schemas.ts`), and reports the Welcome and
 * GroupInfo, which carry the whole ratchet tree, beside that limit.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { MLS_SUITE } from "@/lib/chat/e2ee/mls-client";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";

type MlsMemberClass = import("@/lib/chat/e2ee/mls-client").MlsMemberClass;
type MlsMemberLike = import("@/lib/chat/e2ee/mls-client").MlsMemberLike;

const nativeDir = join(dirname(fileURLToPath(import.meta.url)), "../../../../../packages/core-rs/native");
const nativeFile = existsSync(nativeDir) ? readdirSync(nativeDir).find((f) => f.startsWith(`polaris-core.${process.platform}-${process.arch}`)) : undefined;
const sizes = (process.env.POLARIS_MLS_MEASURE ?? "")
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 1);

/** The route takes MLS objects as base64url text of at most 1 MiB, so this many bytes. */
const WIRE_LIMIT = Math.floor((1024 * 1024 * 3) / 4);
/** `ADD_BATCH` / `REMOVE_BATCH` in `mls-client.ts`. */
const BATCH = 100;
const encoder = new TextEncoder();

describe.skipIf(!nativeFile || sizes.length === 0)("MLS handshake size with a full tree", () => {
    const { MlsMember } = createRequire(import.meta.url)(join(nativeDir, nativeFile!)) as { MlsMember: MlsMemberClass };
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

            const others = Array.from({ length: size - 1 }, () => member().keyPackage());
            const keyPackage = others[0]!.length;
            let lastAdd = { commit: 0, welcome: 0 };
            for (let i = 0; i < others.length; i += BATCH) {
                const out = committer.addMembers(groupId, others.slice(i, i + BATCH));
                committer.mergePendingCommit(groupId);
                lastAdd = { commit: out.commit.length, welcome: out.welcome?.length ?? 0 };
            }
            expect(committer.members(groupId)).toHaveLength(size);
            const groupInfo = committer.groupInfo(groupId).length;

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
                groupInfo,
                removeOneCommit: removeOne.commit.length,
                addOneCommit: addOne.commit.length,
                addOneWelcome: addOne.welcome?.length ?? 0,
                removeBatchCommit: removeBatch,
                wireLimit: WIRE_LIMIT
            };
            console.log(`mls-size ${JSON.stringify(line)}`);
            expect(line.removeOneCommit).toBeLessThan(WIRE_LIMIT);
            expect(line.addOneCommit).toBeLessThan(WIRE_LIMIT);
        }, 600_000);
    }
});
