import { describe, expect, it } from "vitest";
import * as core from "../src/index";

describe("the parts of a person an identity carries", () => {
    it("reads each status from a form option in several languages", () => {
        expect(core.maritalStatusOf("Soltero/a")).toBe("single");
        expect(core.maritalStatusOf("Casado/a")).toBe("married");
        expect(core.maritalStatusOf("Pareja de hecho")).toBe("partnership");
        expect(core.maritalStatusOf("Separado/a")).toBe("separated");
        expect(core.maritalStatusOf("Divorced")).toBe("divorced");
        expect(core.maritalStatusOf("Viudo/a")).toBe("widowed");
        expect(core.maritalStatusOf("Selecciona")).toBeNull();
    });

    it("accepts only real dates", () => {
        expect(core.dateParts("1990-02-28")).toEqual({ year: 1990, month: 2, day: 28 });
        expect(core.dateParts("1990-02-30")).toBeNull();
        expect(core.dateParts("28/02/1990")).toBeNull();
    });

    it("normalises before storing", () => {
        expect(
            core.normalizePerson({
                nationalId: " 12 345 678-z ",
                birthDate: "2001-13-01",
                birthCountry: "es",
                nationality: "Spain",
                maritalStatus: "married"
            })
        ).toEqual({ nationalId: "12345678-Z", birthDate: "", birthCountry: "ES", nationality: "", maritalStatus: "married" });
    });

    it("round-trips through custom fields, touching only what changed", () => {
        const fields = [{ name: "Other", value: "x", type: 0 }];
        const person = { ...core.normalizePerson({}), nationalId: "X1234567L", birthDate: "1990-05-04" };
        const written = core.writePerson(fields, person);
        expect(written.map((field) => field.name)).toEqual(["Other", "National ID", "Date of birth"]);
        expect(core.readPerson(written)).toEqual(person);
        expect(core.writePerson(written, person)).toEqual(written);
    });
});
