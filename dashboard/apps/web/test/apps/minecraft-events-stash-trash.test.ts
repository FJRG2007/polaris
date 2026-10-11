/**
 * The in-server stash and the trash slot. A stack the player threw into the
 * trash slot was kept as a loose stack and handed back into the bag on the
 * way home - so the one dirt an operator once threw away turned up in their
 * inventory after every event. The mod is Java with no test harness here, so
 * this reads its source: the trash slot's stack is kept under a slot of its
 * own and goes back into the trash slot, never into the bag.
 */
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const STASH = readFileSync(
    join(
        __dirname,
        "../../../../resources/minecraft/polaris-neoforge/src/main/java/polaris/minecraft/EventStash.java"
    ),
    "utf8"
);

/** The body of one of the class's methods, from its signature to the next one. */
function method(name: string): string {
    const start = STASH.indexOf(`static JsonObject ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const next = STASH.indexOf("\n    static ", start + 1);
    return STASH.slice(start, next === -1 ? undefined : next);
}

describe("the in-server stash and the trash slot", () => {
    it("keeps the trash slot's stack under a slot of its own, not as a loose one", () => {
        expect(STASH).toMatch(/static final int TRASHED = -1001;/);
        const save = method("save");
        expect(save).toContain('entry.putInt("slot", TRASHED);');
        expect(save).not.toMatch(/loose\(trashed,/);
    });

    it("gives the trash slot's stack back to the trash slot, and to the bag only without the mod", () => {
        const restore = method("restore");
        const branch = restore.slice(restore.indexOf("if (slot == TRASHED)"));
        expect(branch).toMatch(
            /if \(slot == TRASHED\) \{[\s\S]*?trashOf\(player\);[\s\S]*?if \(trash != null\) trash\.put\(TRASH, stack\.get\(\)\.save\(registries\)\);\s*else displaced\.add\(stack\.get\(\)\);\s*continue;/
        );
        // Handled before the slot-by-slot path, so it never reaches the bag.
        expect(restore.indexOf("if (slot == TRASHED)")).toBeLessThan(
            restore.indexOf("ItemStack now = get(inventory, slot);")
        );
    });
});
