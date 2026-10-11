// @vitest-environment jsdom

/**
 * The enchantments dialog on a stack a player holds: it opens on what the stack
 * has, saves only a set that differs and that the action would accept, and
 * shows a mod's enchantment by its id so it can still be levelled or removed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { InventoryItem } from "@polaris-app/game-servers/src/lib/minecraft/inventory";

Object.assign(Element.prototype, {
    hasPointerCapture: () => false,
    setPointerCapture: () => undefined,
    releasePointerCapture: () => undefined,
    scrollIntoView: () => undefined
});

vi.mock("@polaris/app-host/client", () => ({
    hostUi: { i18nProvider: { useLocale: () => "en-US" } }
}));

const { EnchantStackDialog } = await import(
    "@polaris-app/game-servers/src/screens/installed/minecraft-enchantments"
);

afterEach(cleanup);

function sword(snbt: string): InventoryItem {
    return {
        slot: 0,
        id: "minecraft:diamond_sword",
        count: 1,
        data: { era: "components", snbt }
    };
}

function open(item: InventoryItem, onSave = vi.fn()) {
    render(
        <EnchantStackDialog
            item={item}
            where="Hotbar 1"
            available={null}
            onClose={() => undefined}
            onSave={onSave}
        />
    );
    return onSave;
}

const save = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;

describe("EnchantStackDialog", () => {
    it("opens on the stack's own set and saves nothing until it changes", () => {
        open(sword('{"minecraft:enchantments": {"minecraft:sharpness": 3}}'));
        const level = screen.getByLabelText("Level of Sharpness") as HTMLInputElement;
        expect(level.value).toBe("3");
        expect(save().disabled).toBe(true);
        fireEvent.change(level, { target: { value: "5" } });
        expect(save().disabled).toBe(false);
        // Put back is unchanged again.
        fireEvent.change(level, { target: { value: "3" } });
        expect(save().disabled).toBe(true);
    });

    it("holds a level past the maximum until that is switched on", () => {
        const onSave = open(sword('{"minecraft:enchantments": {"minecraft:sharpness": 3}}'));
        fireEvent.change(screen.getByLabelText("Level of Sharpness"), {
            target: { value: "10" }
        });
        expect(screen.getByRole("alert").textContent).toContain("normal maximum of 5");
        expect(save().disabled).toBe(true);
        fireEvent.click(screen.getByRole("switch", { name: "Past the normal maximum" }));
        expect(save().disabled).toBe(false);
        fireEvent.click(save());
        expect(onSave).toHaveBeenCalledWith({
            enchantments: [{ id: "minecraft:sharpness", level: 10 }],
            overMax: true
        });
    });

    it("opens a stack already past the maximum without calling it an error", () => {
        open(sword('{"minecraft:enchantments": {"minecraft:sharpness": 20}}'));
        expect(screen.queryByRole("alert")).toBeNull();
        expect(
            screen
                .getByRole("switch", { name: "Past the normal maximum" })
                .getAttribute("aria-checked")
        ).toBe("true");
    });

    it("shows a mod's enchantment by id and removes it like any other", () => {
        const onSave = open(
            sword('{"minecraft:enchantments": {"minecraft:sharpness": 3, "somemod:lifesteal": 2}}')
        );
        expect(screen.getByText("somemod:lifesteal")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Remove Lifesteal" }));
        fireEvent.click(save());
        expect(onSave).toHaveBeenCalledWith({
            enchantments: [{ id: "minecraft:sharpness", level: 3 }],
            overMax: false
        });
    });

    it("removes every enchantment at once", () => {
        const onSave = open(
            sword('{"minecraft:enchantments": {"minecraft:sharpness": 3, "minecraft:looting": 2}}')
        );
        fireEvent.click(screen.getByRole("button", { name: "Remove every enchantment" }));
        expect(screen.getByText("No enchantments.")).toBeTruthy();
        fireEvent.click(save());
        expect(onSave).toHaveBeenCalledWith({ enchantments: [], overMax: false });
    });
});
