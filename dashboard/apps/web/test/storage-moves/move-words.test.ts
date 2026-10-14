import { describe, expect, it } from "vitest";

import * as words from "@/components/storage-move-words";
import type { ActiveMoveView } from "@/lib/storage-moves/service";

function move(dockerName: string | null): ActiveMoveView {
    return {
        id: "move-1",
        phase: "copying",
        volumeName: "data",
        appName: "app",
        targetLabel: "disk-b",
        totalBytes: 1000,
        copiedBytes: 400,
        percent: 40,
        machine: null,
        containers: ["polaris-move-1", "polaris-move-1-clean"],
        dockerName,
        auto: false
    };
}

const copier = [{ name: "/polaris-move-1" }];

describe("moveOfVolume", () => {
    it("marks only the original once the move knows its name", () => {
        const moves = [move("app_data")];
        expect(words.moveOfVolume({ name: "app_data", heldBy: copier }, moves)).toBe(moves[0]);
        expect(words.moveOfVolume({ name: "app_data_moved", heldBy: copier }, moves)).toBeNull();
    });

    it("falls back to the copier before the name is recorded", () => {
        const moves = [move(null)];
        expect(words.moveOfVolume({ name: "app_data", heldBy: copier }, moves)).toBe(moves[0]);
        expect(words.moveOfVolume({ name: "other", heldBy: [] }, moves)).toBeNull();
    });
});
