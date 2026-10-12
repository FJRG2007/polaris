/**
 * Seasonal decorations a player breaks. A decoration is only drawn on a
 * player's screen, so breaking a pumpkin broke the grass under it (a hole and
 * a dirt block), breaking one that stood in air did nothing and it popped back,
 * and every chunk decided again - a relog, a trip away, a restart - drew the
 * broken ones again. Separately, a chunk the player's game loaded again wiped
 * the decorations in it until the next resend, so they blinked out. The mod is
 * Java with no test harness here, so this reads its source.
 */
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MINECRAFT = join(__dirname, "../../../../resources/minecraft");

function source(path: string): string {
    return readFileSync(join(MINECRAFT, path), "utf8");
}

const NEO_DECOR = source("polaris-neoforge/src/main/java/polaris/minecraft/SeasonalDecor.java");
const NEO_HALLOWEEN = source(
    "polaris-neoforge/src/main/java/polaris/minecraft/SeasonalHalloween.java"
);
const PAPER_DECOR = source("polaris-paper/src/main/java/polaris/minecraft/SeasonalDecor.java");
const PAPER_HALLOWEEN = source(
    "polaris-paper/src/main/java/polaris/minecraft/SeasonalHalloween.java"
);
const BROKEN = source("polaris-common/src/main/java/polaris/minecraft/BrokenDecor.java");

/** A method of the class, from its signature to its closing brace. */
function body(text: string, signature: string): string {
    const start = text.indexOf(signature);
    expect(start, signature).toBeGreaterThan(-1);
    const end = text.indexOf("\n    }\n", start);
    return text.slice(start, end);
}

describe("a decoration a player hits", () => {
    it("comes down on the first hit, which is called off so the ground under it stays", () => {
        const neo = body(NEO_DECOR, "public void onHit(PlayerInteractEvent.LeftClickBlock event)");
        expect(neo).toContain("LeftClickBlock.Action.START");
        expect(neo).toContain("takeDown(player, event.getPos())");
        expect(neo).toContain("event.setCanceled(true)");
        const paper = body(PAPER_DECOR, "public void onHit(PlayerInteractEvent event)");
        expect(paper).toContain("Action.LEFT_CLICK_BLOCK");
        expect(paper).toContain("event.setCancelled(true)");
    });

    it("is taken down for every player, not only the one who hit it, and remembered", () => {
        for (const decor of [NEO_DECOR, PAPER_DECOR]) {
            const takeDown = body(decor, "takeDown(");
            expect(takeDown).toMatch(/broken\.add\(/);
            // Marked, not written: a row knocked down is one write, not one each.
            expect(takeDown).toMatch(/brokenDirty = true/);
            expect(takeDown).not.toMatch(/writeBroken\(\)/);
            expect(takeDown).toMatch(/for \((ServerPlayer|Player) other :/);
            // A real block only drawn snowy is the player digging: left to the game.
            expect(takeDown).toContain("redrawn(hit)");
        }
    });

    it("is never drawn again while the season lasts", () => {
        expect(NEO_DECOR).toContain("fakes.removeIf(SeasonalDecor::wasBroken);");
        expect(PAPER_DECOR).toContain("fakes.removeIf(this::wasBroken);");
        for (const decor of [NEO_DECOR, PAPER_DECOR]) {
            expect(decor).toMatch(/keepBroken\(\w*,? ?next\);\n\s+untilMillis/);
        }
    });

    it("keeps the trap pumpkins, now fired by the take-down instead of a break", () => {
        expect(NEO_DECOR).toContain(
            "SeasonalHalloween.trap(player, player.serverLevel(), event.getPos())"
        );
        expect(PAPER_HALLOWEEN).toContain("decor.onPumpkinTaken(this::trap);");
        for (const halloween of [NEO_HALLOWEEN, PAPER_HALLOWEEN]) {
            expect(halloween).not.toMatch(/BreakEvent/);
            expect(halloween).not.toContain("takePumpkin");
        }
    });
});

describe("the broken list", () => {
    it("is written every few seconds while it changes, and before it is let go", () => {
        for (const decor of [NEO_DECOR, PAPER_DECOR]) {
            expect(decor).toMatch(/if \(ticks % FLUSH_TICKS == 0\) flushBroken\(\);/);
            expect(decor).toMatch(/if \(brokenDirty\) writeBroken\(\);/);
            // Written, it is clean again, whether or not the write went through.
            expect(body(decor, "void writeBroken()")).toContain("brokenDirty = false;");
        }
        // Switched off, and the server going down: nothing knocked down is lost.
        expect(body(NEO_DECOR, "static JsonObject clear(MinecraftServer server)")).toContain(
            "flushBroken();"
        );
        expect(
            body(NEO_DECOR, "public void onServerStopping(ServerStoppingEvent event)")
        ).toContain("flushBroken();");
        expect(body(PAPER_DECOR, "private JsonObject clear()")).toContain("flushBroken();");
        expect(body(PAPER_DECOR, "void stop()")).toContain("flushBroken();");
    });

    it("is kept per season beside the world and dropped for another season or a stale one", () => {
        const keepFor = body(BROKEN, "boolean keepFor(String next, long now)");
        expect(keepFor).toContain("season.equals(next) && now - since <= KEPT_MILLIS");
        expect(keepFor).toContain("positions.clear()");
        expect(BROKEN).toContain("StandardCopyOption.ATOMIC_MOVE");
        expect(BROKEN).toMatch(/static final int MOST = /);
        for (const decor of [NEO_DECOR, PAPER_DECOR])
            expect(decor).toContain('BROKEN_FILE = "polaris-season-broken.json"');
    });
});

describe("a chunk sent to a player's game again", () => {
    it("gets its decorations back straight after it on NeoForge", () => {
        const sent = body(NEO_DECOR, "public void onChunkSent(ChunkWatchEvent.Sent event)");
        expect(sent).toContain("showStill(player, event.getLevel(), fakes)");
    });

    it("is forgotten past the view distance on Paper, so it is decided and shown again", () => {
        expect(PAPER_DECOR).toContain("Math.min(FORGET, Bukkit.getViewDistance())");
    });
});
