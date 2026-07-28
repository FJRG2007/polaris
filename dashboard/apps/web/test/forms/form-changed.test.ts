/**
 * The comparison behind "nothing to save yet". What matters is that it answers
 * "are these the same values" rather than "did somebody type": editing a field
 * and putting it back has to read as unchanged, and an unticked checkbox - which
 * a form simply omits - must not look different from one that was never there.
 */

import { describe, expect, it } from "vitest";
import { formSnapshot } from "../../src/lib/use-form-changed";

function form(values: Record<string, string>): FormData {
    const data = new FormData();
    for (const [name, value] of Object.entries(values)) data.append(name, value);
    return data;
}

describe("form snapshot", () => {
    it("reads the same for the same values, whatever order they came in", () => {
        expect(formSnapshot(form({ name: "Home", host: "10.0.0.2" }))).toBe(
            formSnapshot(form({ host: "10.0.0.2", name: "Home" }))
        );
    });

    it("changes with a value and comes back when it is put back", () => {
        const before = formSnapshot(form({ name: "Home" }));
        const edited = formSnapshot(form({ name: "Home office" }));
        expect(edited).not.toBe(before);
        expect(formSnapshot(form({ name: "Home" }))).toBe(before);
    });

    it("treats a blank password - keep the stored one - as no change", () => {
        expect(formSnapshot(form({ name: "Home", password: "" }))).toBe(
            formSnapshot(form({ name: "Home", password: "" }))
        );
        expect(formSnapshot(form({ name: "Home", password: "typed" }))).not.toBe(
            formSnapshot(form({ name: "Home", password: "" }))
        );
    });

    it("notices a checkbox being ticked, which a form reports by its absence", () => {
        expect(formSnapshot(form({ secure: "on" }))).not.toBe(formSnapshot(form({})));
    });

    it("compares a chosen file by name and size", () => {
        const withFile = (name: string, body: string) => {
            const data = new FormData();
            data.append("key", new File([body], name));
            return formSnapshot(data);
        };
        expect(withFile("id_rsa", "aaa")).toBe(withFile("id_rsa", "bbb"));
        expect(withFile("id_rsa", "aaa")).not.toBe(withFile("id_ed25519", "aaa"));
        expect(withFile("id_rsa", "aaa")).not.toBe(withFile("id_rsa", "longer body"));
    });
});
