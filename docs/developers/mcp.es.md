# MCP: herramientas, búsqueda y categorías

[Read in English](mcp.md) - [Volver al README](../../README.es.md)

Polaris es un único servidor MCP (`/api/mcp`) para todas las apps instaladas en
él. Un modelo se conecta una vez y llega por él a hogar, correo, calendario,
juegos y el resto, así que hay dos cosas que importan más que cualquier
herramienta concreta: el modelo tiene que poder encontrar lo que busca, y una
persona tiene que poder leer lo que concede. Esta página explica cómo ampliarlo
sin romper ninguna de las dos.

| Pieza | Dónde |
| --- | --- |
| Protocolo, `McpTool`, `toolCategory` | `apps/web/src/lib/mcp/protocol.ts` |
| Scopes y categorías | `apps/web/src/lib/mcp/scope-table.ts` |
| Herramientas del núcleo y proveedores de búsqueda | `apps/web/src/lib/mcp/tools/*.ts`, listados en `tools/index.ts` |
| `polaris_search`, `polaris_tools` | `apps/web/src/lib/mcp/tools/discovery.ts`, `lib/mcp/search.ts` |
| Coincidencia tolerante | `packages/core/src/entity-match.ts` |
| Etiquetas | `apps/web/messages/<locale>/mcp.json` |

## Añadir una herramienta

1. Escríbela con `defineMcpTool` (núcleo) o `host.mcp.defineTool` (una app
   instalable). Obligatorio: `name` (`<app>_<verbo>`, en minúsculas),
   `description` (la primera frase es lo que muestra `polaris_tools`), un
   `input` de Zod, `scope` y `readOnly`. Pon `destructive` e `idempotent` en
   todo lo que escribe.
2. `category` es opcional: sin ella, la herramienta se lista en la categoría de
   su primer scope. Ponla solo cuando eso sería incorrecto.
3. Regístrala. Núcleo: añádela a la lista de `tools/index.ts`. Una app:
   devuélvela desde el hook `mcpTools` de su extensión (mira
   `apps/places/src/lib/places-extension.ts`). El catálogo
   (`lib/mcp/catalog.ts`) descarta, y registra en el log, una herramienta de app
   cuyo nombre ya está ocupado o cuyo scope no está en la tabla.
4. Si recibe un texto de búsqueda, compara con `findEntities` / `matchForModel`
   de `@polaris/core`, nunca con `includes()`. Ignoran acentos y mayúsculas,
   conocen las palabras en inglés y en español de cada tipo de cosa ("puerta"
   encuentra una cerradura), perdonan erratas y nunca responden vacío mientras
   haya algo alcanzable: sin coincidencias devuelven las filas más cercanas,
   acotadas, con una frase que lo dice. Un almacén demasiado grande para
   listarlo (el correo) filtra primero en su propia consulta y ordena lo que
   vuelve.
5. Aplica todo lo que sea más fino que el scope dentro de `run`, con las mismas
   comprobaciones que usan las pantallas de la app (`placesReach`, el ámbito
   visible de la capa de tareas). El scope solo dice que la credencial puede
   usar la herramienta.
6. Pruébala como lo hace `test/mcp/app-tools-places-games.test.ts`: a través de
   `handleMcpMessage`, con los scopes que llevaría una concesión real.

## Añadir un proveedor de búsqueda

Toda app que posee cosas a las que una persona pone nombre (dispositivos,
servidores, notas) debería poder encontrarse desde `polaris_search`. Un
proveedor:

```ts
host.mcp.defineSearch({
    id: "databases.connections",          // unique, <app>.<what>
    app: "databases",
    category: "databases",
    scope: "databases.read",              // or a list, any one of which will do
    async search(query, caller, limit) {
        const rows = await reachableConnections(caller.userId, limit);
        return rows.map((row) => ({
            id: row.id,
            name: row.name,
            kind: "database",
            where: row.server,
            keywords: [row.engine],       // found by these, not shown
            next: [{ tool: "databases_query", args: { connectionId: row.id } }]
        }));
    }
});
```

- Devuelve candidatos, no un veredicto. El orden se decide una vez, en
  `searchEverywhere`, para que los resultados de todas las apps sigan la misma
  regla. Un proveedor que lee más filas que `limit` las pasa por
  `preferMatches`, para que lo que descarta sea lo que la consulta no nombró.
- Devuelve solo lo que alcanza quien llama. Al proveedor solo se le pregunta
  cuando quien llama tiene su scope; el acceso por elemento es tarea del
  proveedor.
- Tiene `PROVIDER_TIMEOUT_MS` (4 s) y `PROVIDER_LIMIT` (200 resultados). Uno que
  lanza un error o se queda sin tiempo se deja fuera y se nombra en la
  respuesta; la búsqueda responde igualmente.
- Los pasos `next` que nombran una herramienta que quien llama no puede usar se
  eliminan solos.
- Regístralo: en el núcleo en `MCP_SEARCH_PROVIDERS` (`tools/index.ts`), en una
  app desde el hook `mcpSearch` de su extensión.

## Añadir una categoría

1. Añade el id a `MCP_CATEGORIES` en `scope-table.ts`, donde el orden es el
   orden en que lo muestran las pantallas y `polaris_tools`.
2. Añade `categories.<id>` a `messages/<locale>/mcp.json` en todos los idiomas.
   Un test (`test/mcp/scope-table.test.ts`) falla mientras falte en alguno.
3. Clasifica scopes en ella: un permiso en `PERMISSION_CATEGORIES` (un `Record`
   sobre todos los permisos, así que un permiso nuevo sin categoría no compila),
   un scope más fino solo de MCP por su `category` en `MCP_ONLY_SCOPES`.

## Añadir un scope

Una línea en `scope-table.ts` y su etiqueta `scopes.<area>_<verbo>` en el
`mcp.json` de cada idioma. Márcalo como `sensitive` cuando actúa fuera de
Polaris o en el mundo físico (enviar correo, abrir una puerta): la pantalla de
consentimiento nunca lo marca por la persona, y la casilla "permitir todo" de
una categoría lo deja como está.
