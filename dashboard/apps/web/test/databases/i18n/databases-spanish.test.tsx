/**
 * The Databases app, in Spanish.
 *
 * The connection form's complaints, the service's refusals and the engines'
 * figures are all written in English under `lib/data`, and reach the screen
 * through `lib/data/words`: the English catalog is held to those sentences here,
 * and a sample of each is read in Spanish.
 */

import { describe, expect, it } from "vitest";
import { ReadOnlyError } from "@/lib/data/driver";
import { translatorFor } from "@/lib/i18n/translate";
import { connectionIssues } from "@/lib/data/connection-schema";
import { dataText, KNOWN_DATA_REFUSALS, statText, whereText } from "@/lib/data/words";

const english = translatorFor("en-US", "databases");
const spanish = translatorFor("es-ES", "databases");

describe("the English that lib/data writes", () => {
    it("comes back exactly as it went in", () => {
        for (const message of KNOWN_DATA_REFUSALS) expect(dataText(english, message)).toBe(message);
        const readOnly = new ReadOnlyError("changing a value").message;
        expect(dataText(english, readOnly)).toBe(readOnly);
        const signIn =
            "Polaris could not sign in to db.example.com:22 over SSH through bastion. Check the address, the user and the key.";
        expect(dataText(english, signIn)).toBe(signIn);
        expect(whereText(english, "10.0.0.5:5432 via deploy@ssh.example.com through bastion")).toBe(
            "10.0.0.5:5432 via deploy@ssh.example.com through bastion"
        );
        expect(statText(english, "Buffer pool hits")).toBe("Buffer pool hits");
    });
});

describe("in Spanish", () => {
    it("says what is wrong with a connection being typed", () => {
        const issues = connectionIssues({
            id: null,
            name: "Producción",
            engine: "postgres",
            managedDatabaseId: null,
            host: "postgres://user@db",
            port: 5432,
            database: "app",
            username: "app",
            password: null,
            tls: false,
            readOnly: false,
            ssh: null
        });
        expect(dataText(spanish, issues.host)).toBe("Escribe un nombre de host o una dirección IP, sin el resto de una URL.");
    });

    it("reads a read-only refusal and an SSH failure", () => {
        expect(dataText(spanish, new ReadOnlyError("changing a value").message)).toBe(
            "Esta conexión es de solo lectura, y cambiar un valor cambiaría la base de datos. Desactiva el modo de solo lectura en la conexión si era tu intención."
        );
        expect(
            dataText(
                spanish,
                "Polaris could not sign in to db.example.com:22 over SSH. Check the address, the user and the password."
            )
        ).toBe("Polaris no ha podido iniciar sesión en db.example.com:22 por SSH. Revisa la dirección, el usuario y la contraseña.");
        expect(whereText(spanish, "The instance's own data")).toBe("Datos de la instancia");
        expect(statText(spanish, "Rows read")).toBe("Filas leídas");
    });

    it("lets an engine's own error through untouched", () => {
        expect(dataText(spanish, 'relation "users" does not exist')).toBe('relation "users" does not exist');
    });
});
