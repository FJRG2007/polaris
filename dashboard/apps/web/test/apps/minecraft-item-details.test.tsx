// @vitest-environment jsdom

/**
 * What a stack is besides its id: the inventory screen showed an enchanted book
 * as a book, with nothing to say which enchantments it held, and an enchanted
 * sword exactly like a plain one.
 */

import { MessagesWrapper } from "../setup/i18n";
// The dashboard's pieces the screen takes, as the layout provides them.
import "@/components/app-host/client";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InventoryGrid } from "@polaris-app/game-servers/src/screens/installed/minecraft-inventory";
import {
    enchantmentText,
    itemDetails,
    levelText
} from "@polaris-app/game-servers/src/lib/minecraft/item-details";
import { parseInventory } from "@polaris-app/game-servers/src/lib/minecraft/inventory";

afterEach(cleanup);

/** A 1.21.4 bag as the server answers it: an enchanted book, a renamed and worn
 *  bow, and a stack of plain dirt. */
const REPLY = `Steve has the following entity data: [${[
    `{count: 1, Slot: 0b, components: {"minecraft:stored_enchantments": {levels: {"minecraft:mending": 1, "minecraft:sharpness": 5}}}, id: "minecraft:enchanted_book"}`,
    `{count: 1, Slot: 1b, components: {"minecraft:custom_name": '{"text":"Old Faithful"}', "minecraft:enchantments": {levels: {"minecraft:power": 5, "minecraft:infinity": 1}}, "minecraft:damage": 41, "minecraft:repair_cost": 1}, id: "minecraft:bow"}`,
    `{count: 64, Slot: 2b, id: "minecraft:dirt"}`
].join(", ")}]`;

describe("itemDetails", () => {
    const [book, bow, dirt] = parseInventory(REPLY);

    it("reads what an enchanted book stores, apart from what is on an item", () => {
        expect(itemDetails(book!.data)).toMatchObject({
            enchantments: [],
            stored: [
                { id: "minecraft:mending", level: 1 },
                { id: "minecraft:sharpness", level: 5 }
            ]
        });
    });

    it("reads a typed name, the enchantments and the wear", () => {
        expect(itemDetails(bow!.data)).toMatchObject({
            name: "Old Faithful",
            enchantments: [
                { id: "minecraft:power", level: 5 },
                { id: "minecraft:infinity", level: 1 }
            ],
            stored: [],
            damage: 41
        });
        expect(itemDetails(dirt!.data)).toMatchObject({
            name: null,
            enchantments: [],
            damage: null
        });
    });

    it("reads 1.21.5's shape, without `levels`, and the old `tag` one", () => {
        expect(
            itemDetails({
                era: "components",
                snbt: '{"minecraft:enchantments": {"minecraft:efficiency": 4}, "minecraft:custom_name": {text: "Digger"}}'
            })
        ).toMatchObject({
            name: "Digger",
            enchantments: [{ id: "minecraft:efficiency", level: 4 }]
        });
        expect(
            itemDetails({
                era: "tag",
                snbt: '{StoredEnchantments: [{id: "minecraft:looting", lvl: 3s}], Damage: 0}'
            })
        ).toMatchObject({ stored: [{ id: "minecraft:looting", level: 3 }], damage: null });
    });

    it("writes levels the way the game does", () => {
        expect([1, 4, 5, 10, 255].map(levelText)).toEqual(["I", "IV", "V", "X", "255"]);
        expect(enchantmentText({ id: "minecraft:fire_protection", level: 4 })).toBe(
            "Fire Protection IV"
        );
    });
});

describe("the inventory grid", () => {
    it("spells out the stack pointed at, books included", () => {
        render(
            <MessagesWrapper>
                <InventoryGrid items={parseInventory(REPLY)} />
            </MessagesWrapper>
        );
        fireEvent.pointerEnter(screen.getByLabelText(/Enchanted Book/));
        expect(screen.getByText("Stores Mending I, Sharpness V")).toBeTruthy();

        fireEvent.focus(screen.getByLabelText(/Old Faithful/));
        expect(screen.getByText("Power V, Infinity I")).toBeTruthy();
        expect(screen.getByText("41 damage taken")).toBeTruthy();
    });
});
