# Fase 0: elección de la biblioteca MLS para Polaris Chat

Prueba técnica de la fase 0 de [la propuesta de E2EE](chat-e2ee-proposal.md) (sección 9). Fecha: 2026-11-21.
El código está en `dashboard/experiments/mls-spike/`, fuera de los workspaces del dashboard; ningún código de
producción lo importa y el CI del dashboard lo ignora (`!dashboard/experiments/**`).

Supuesto de partida (actualizado por el propietario durante la prueba): **E2EE activado por defecto en todos los
chats**, incluidos canales de servidor de cientos o miles de miembros, sin que el usuario lo note, y con todo el
historial migrado. El listón es de nivel gubernamental: auditorías, mantenimiento y seguridad de memoria pesan más
que la comodidad.

## Veredicto

**OpenMLS**, compilado por nosotros a WebAssembly con `wasm-bindgen` (no el paquete npm `openmls-wasm`, que publica
un tercero). Razones, por orden de peso:

1. **Es la única de las tres con auditoría externa publicada**: SRLabs, financiada por la Sovereign Tech Agency,
   mayo de 2026; 8 hallazgos (uno alto) [1]. mls-rs dice en su README que no tiene auditoría de terceros [5];
   ts-mls también lo dice [7].
2. **Rust, memoria segura**, con la criptografía dentro del propio WASM (RustCrypto). No depende de qué algoritmos
   tenga WebCrypto en cada navegador o WebView: corrió igual en Chromium y en WebKit. ts-mls falló en WebKit por
   eso (abajo).
3. **Escala**: procesar un commit a 1.000 miembros cuesta 14 ms en Chromium frente a 75-146 ms de ts-mls, y la unión
   externa 153 ms frente a 4,8 s. A 5.000 miembros OpenMLS termina (nativo); ts-mls revienta la pila.
4. **El mismo núcleo puede correr nativo** en Android/iOS (para notificaciones), así que el estado del grupo no
   tiene que traducirse entre dos implementaciones distintas.
5. Proyecto activo y amplio: MIT, 69 contribuidores, último push 2026-11-20, versión 0.9.2 de 2026-10-22 [2][3].

El coste es el peso: **371 KB brotli** (1,5 MB sin comprimir) frente a 33 KB de ts-mls. Se paga una vez por
versión con caché y carga diferida (sección "Arranque en frío").

## Candidatas

| | OpenMLS | mls-rs (AWS) | ts-mls |
| --- | --- | --- | --- |
| Lenguaje | Rust -> WASM | Rust -> WASM | TypeScript puro |
| Licencia | MIT [3] | Apache-2.0 [4] | MIT [8] |
| Versión evaluada | 0.9.2 (crates.io, 2026-10-22) | 0.58.0 (crates.io, 2026-11-18), no medida | 1.6.4 (npm) |
| Auditoría externa | Sí: SRLabs / Sovereign Tech Agency, 2026-05-27, 8 hallazgos (1 alto) [1] | No: "has not yet received a full security audit by a 3rd party" [5] | No: "has not undergone a formal security audit" [7] |
| Avisos de seguridad conocidos | GHSA-8x3w-qj7j-gqhf, bypass de autenticación con etiquetas truncadas, corregido en 0.7.2 [6]; fallo de persistencia del secret tree [6] | - | - |
| Mantenimiento | 69 contribuidores, 1.071 estrellas, push 2026-11-20 [3] | 27 contribuidores, 263 estrellas, push 2026-11-18 [4] | 11 contribuidores, 111 estrellas, un solo mantenedor en npm, push 2026-11-19 [8] |
| Paquete npm oficial | No. `openmls-wasm@0.1.0` lo publica una cuenta ajena al proyecto (2025-10-10): **descartado** | No hay paquete oficial; existe `@river-build/mls-rs-wasm` de un tercero | Sí |
| Cadena de suministro | Crates de RustCrypto; `Cargo.lock` fijado | - | 4 paquetes; **usa `@noble/hashes` sin declararlo** (se rompe al importar si no se instala a mano) |
| External commits | Sí (`join_by_external_commit`, marcado obsoleto en favor de `external_commit_builder`) | Sí según su README [5] | Sí (`joinGroupExternal`) |
| Serializar estado | Por `StorageProvider` clave-valor; se puede volcar y recargar (`MlsGroup::load`) | Por proveedor de almacenamiento | `encodeGroupState` / `decodeGroupState` (también sin el árbol) |
| Poscuántico | Feature `draft-ietf-mls-pq-ciphersuites` | - | X-Wing y ML-KEM [7] |

mls-rs no se midió: con el presupuesto de la prueba se priorizó tener OpenMLS y ts-mls de punta a punta. Sin
auditoría externa no cumple el listón aunque rindiera igual; sigue siendo la alternativa si OpenMLS se estancara.

## Dónde corre Polaris

| Superficie | Motor | Ejecutado aquí |
| --- | --- | --- |
| Web | Navegadores actuales | Chromium headless 156 (Playwright): **sí** |
| Polaris Desktop | Electron 44.3.0 = Chromium 152 [9] | Cubierto por Chromium 156 (mismo motor, WASM y WebCrypto equivalentes); Electron en sí no se lanzó |
| Android | WebView del sistema (`android.webkit.WebView`), `minSdk 26`; versión de Chromium según el dispositivo | **No ejecutado**. Se aproxima con Chromium headless con CPU x4 más lenta |
| iOS | `WKWebView` (motor de Safari del sistema) | **No ejecutado**. Se aproxima con WebKit 27.2 de Playwright para Windows, que no es Safari: el motor JS es el mismo pero WebCrypto usa otro backend |

WebAssembly está disponible desde Chrome 57 y Safari/iOS 11, así que OpenMLS no tiene problema de soporte en ninguna
de las cuatro. ts-mls exige **Ed25519 en WebCrypto** (lo llama con `crypto.subtle` y solo cae a `@noble/curves` si
no existe `crypto.subtle` en absoluto): eso es Chrome 137+ y Safari 17+. En WebKit de Playwright falló con
`NotSupportedError` en el primer paso. Un WebView de Android sin actualizar o un iOS 16 quedarían igual.

## Escenario medido

Por tamaño N: crear el grupo con N miembros en un solo commit, unir a un segundo dispositivo por Welcome, añadir y
quitar un miembro (commit y procesado en el receptor), 50 mensajes de 200 bytes cifrados y descifrados (20 a partir
de 1.000), clave de contenido por el exporter (`"polaris/content"` con la época, diseño 3.2) comparada entre emisor y
receptor, volcado y recarga del estado del receptor seguido de un descifrado, y unión externa (GroupInfo + external
commit). Ciphersuite 0x0001 (`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`). Todos los mensajes pasan por el formato
de cable (serializar y parsear). En todas las ejecuciones las tres comprobaciones salieron bien: claves del exporter
iguales, estado recargado descifra, unión externa con la misma clave.

Máquina: equipo de desarrollo Windows 11 x64. Una sola pasada por tamaño: los milisegundos son orientativos, los
bytes son deterministas.

## Peso y arranque en frío

| | Bruto | gzip -9 | brotli 11 |
| --- | --- | --- | --- |
| ts-mls (bundle esbuild minificado, solo lo usado) | 138.055 B | 37.855 B | 32.673 B |
| OpenMLS (wasm + glue de wasm-bindgen, `opt-level="z"`, LTO, sin `wasm-opt`) | 1.507.436 B | 482.343 B | 371.229 B |

El WASM incluye `serde_json` y el código de la prueba; una binding real tendrá un tamaño parecido. Falta pasarle
`wasm-opt -Oz`, que suele recortar algo más.

| Arranque (desde la navegación, servidor local) | Chromium | Chromium CPU x4 | WebKit |
| --- | --- | --- | --- |
| ts-mls: script evaluado | 20 ms | 40 ms | 20 ms (y luego falla) |
| OpenMLS: `init()` del WASM | 16 ms (listo a los 34 ms) | 70 ms (listo a los 110 ms) | 55 ms (listo a los 73 ms) |

Implicaciones con E2EE por defecto: quien usa solo la web abre el chat en cada visita. Compilar el WASM es barato
(70 ms en el proxy de móvil lento); lo caro es **descargar 371 KB** la primera vez. Por tanto:

- Cargarlo de forma diferida al abrir Chat (o en reposo tras el primer pintado), nunca en el camino del primer
  pintado; el resto de la pantalla se pinta sin esperar.
- Servirlo con nombre con hash y `Cache-Control: immutable`, y precargarlo en el Service Worker: después de la
  primera visita no hay descarga y V8 reutiliza el código compilado.
- Instanciar con `WebAssembly.instantiateStreaming` para compilar mientras llega.

## Rendimiento por tamaño de grupo

Chromium 156 headless (WASM para OpenMLS). "Procesar" es el coste en el dispositivo que recibe el commit.

| Operación | Biblioteca | 2 | 50 | 500 | 1.000 |
| --- | --- | --- | --- | --- | --- |
| Crear grupo con N (un commit) | OpenMLS | 11 ms | 14 ms | 214 ms | 633 ms |
| | ts-mls | 4 ms | 18 ms | 180 ms | 435 ms |
| Unirse por Welcome | OpenMLS | 3 ms | 6 ms | 46 ms | 86 ms |
| | ts-mls | 2 ms | 7 ms | 66 ms | 143 ms |
| Añadir 1: crear commit / procesar | OpenMLS | 1,8 / 2 ms | 9,5 / 2 ms | 69 / 8 ms | 130 / 14 ms |
| | ts-mls | 1,5 / 2 ms | 4,7 / 5 ms | 33 / 34 ms | 120 / 75 ms |
| Quitar 1: crear commit / procesar | OpenMLS | 1,4 / 0 ms | 7,5 / 1 ms | 63 / 7 ms | 120 / 15 ms |
| | ts-mls | 2,3 / 1 ms | 15 / 8 ms | 106 / 83 ms | 314 / 146 ms |
| Cifrar / descifrar un mensaje | OpenMLS | 0,11 / 0,14 ms | 0,09 / 0,11 ms | 0,10 / 0,14 ms | 0,11 / 0,14 ms |
| | ts-mls | 0,11 / 0,14 ms | 0,13 / 0,11 ms | 0,08 / 0,11 ms | 0,17 / 0,21 ms |
| Recargar estado | OpenMLS | 2 ms | 0 ms | 4 ms | 6 ms |
| | ts-mls | 1 ms | 8 ms | 52 ms | 152 ms |
| Unión externa (crear) / procesar | OpenMLS | 2 / 0 ms | 8 / 1 ms | 79 / 6 ms | 153 / 13 ms |
| | ts-mls | 3 / 1 ms | 23 / 8 ms | **1.007** / 56 ms | **4.784** / 92 ms |

Proxy de móvil lento (Chromium, CPU x4), 500 miembros: OpenMLS crear 1.159 ms, unirse 236 ms, procesar alta/baja
48 / 45 ms, unión externa 453 ms; ts-mls crear 1.121 ms, unirse 417 ms, procesar alta/baja 222 / 309 ms, unión
externa **6.982 ms**.

WebKit 27.2 (proxy de iOS), OpenMLS, 1.000 miembros: crear 1.192 ms, unirse 170 ms, procesar alta/baja 27 / 23 ms,
unión externa 328 ms, cifrar/descifrar 0,10 / 0,40 ms. ts-mls no corre en este WebKit.

Node 26 (ts-mls): a 1.000 la unión externa tardó 22,6 s; **a 5.000 miembros ts-mls falla** con
`RangeError: Maximum call stack size exceeded` en su codificador recursivo (`codec/variableLength.js`). La pila de un
navegador no se puede ampliar, así que es un límite duro.

### 5.000 miembros

Medido solo con OpenMLS nativo (Rust, Windows); en navegador no se ejecutó. Los bytes son los mismos en WASM:

| 5.000 miembros (OpenMLS) | Valor |
| --- | --- |
| Commit de creación | 1.429.428 B |
| Welcome | 1.669.849 B |
| Commit de alta / baja (árbol recién creado) | 411.042 / 410.768 B |
| Estado del dispositivo | 4.976.299 B |
| Tiempos nativos: crear / unirse / procesar baja | 8,1 s / 7,9 s / 47 ms |

Los tiempos nativos de esta máquina salieron más lentos que los de WASM en Chromium para unirse (1.556 ms frente a
86 ms a 1.000), lo que apunta a un problema del build nativo de la prueba y no de la biblioteca; no se investigó.
Extrapolando la curva de Chromium (x3 al doblar N), crear un grupo de 5.000 en navegador rondaría los 8 s: **no es
algo que deba hacer un navegador en primer plano**.

### Tamaño de los commits: el hallazgo que más importa

| Bytes | Biblioteca | 2 | 50 | 500 | 1.000 | 5.000 |
| --- | --- | --- | --- | --- | --- | --- |
| Commit de creación | OpenMLS | 691 | 14.486 | 142.792 | 285.326 | 1.429.428 |
| | ts-mls | 500 | 16.343 | 165.316 | 330.829 | falla |
| Welcome | OpenMLS | 795 | 17.063 | 167.077 | 333.645 | 1.669.849 |
| | ts-mls | 335 | 6.000 | 59.103 | 118.104 | falla |
| Commit de alta | OpenMLS (con UpdatePath) | 806 | 4.883 | 41.894 | 82.931 | 411.042 |
| | ts-mls (sin path) | 502 | 502 | 500 | 500 | falla |
| Commit de baja | OpenMLS | 498 | 4.609 | 41.620 | 82.657 | 410.768 |
| | ts-mls | 537 | 4.645 | 41.659 | 82.697 | falla |
| Mensaje de 200 B | OpenMLS / ts-mls | 346 / 337 | 346 / 338 | 346 | 346 | 346 |
| GroupInfo con árbol | OpenMLS / ts-mls | 657 / 741 | 9.629 / 11.928 | - | - | - |

El Welcome de OpenMLS lleva el árbol dentro (`use_ratchet_tree_extension`); ts-mls lo pasa aparte en la prueba, por
eso pesa menos.

Un commit de baja crece **lineal** con N (~82 bytes por miembro), no `log(N)`. La causa es el árbol: al crear un grupo
añadiendo a todos de golpe, los nodos intermedios quedan vacíos y cada commit cifra a cada hoja por separado. Es
exactamente lo que hará la **migración** de un canal existente. El `log(N)` de la propuesta solo aparece cuando los
miembros ya han hecho commits propios y han llenado sus caminos. Consecuencias:

- Tras migrar un canal grande, cada dispositivo debe emitir un commit de actualización propio la primera vez que entre,
  para llenar su camino. Hasta entonces cada alta o baja en un canal de 5.000 cuesta ~410 KB por receptor.
- El estado estacionario (árbol lleno) **no se ha medido** en esta prueba; es lo primero que hay que medir en la fase 2.
- Crear un canal de miles de miembros (o migrarlo) tiene que hacerse por tandas, fuera del primer plano (Web Worker),
  o por uniones externas de cada dispositivo.

## Estado guardado por dispositivo (IndexedDB)

Estado de un dispositivo receptor tras el escenario (OpenMLS: todo lo que su `StorageProvider` guarda; ts-mls:
`encodeGroupState`; valores de OpenMLS nativo y ts-mls en Node, que coinciden con Chromium a menos del 0,1 %):

| Miembros | OpenMLS | ts-mls |
| --- | --- | --- |
| 2 | 8.091 B | 3.480 B |
| 50 | 58.315 B | 64.515 B |
| 500 | 492.071 B | 575.640 B |
| 1.000 | 973.184 B | 1.149.755 B |
| 5.000 | 4.976.299 B | falla |

Son ~1 KB por miembro, casi todo el árbol público. Para un usuario en 200 conversaciones, con una mezcla supuesta de
150 MD, 40 grupos de 50 y 10 canales de 1.000: **unos 13 MB con OpenMLS** (1,2 + 2,3 + 9,7 MB). Si esos 10 canales
fueran de 5.000, unos 53 MB. El árbol es público y el servidor ya lo tiene como Delivery Service, así que se puede
guardar solo la parte privada y pedir el árbol al reabrir un canal grande (ts-mls lo trae hecho con
`encodeGroupStateWithoutTree`; en OpenMLS habría que separarlo en el `StorageProvider` propio). A cambio, el árbol
recibido del servidor hay que validarlo entero (hashes de padres y firmas) antes de usarlo.

## Compartir el estado entre WebView y nativo

- OpenMLS guarda todo a través de un `StorageProvider` clave-valor que implementa la aplicación. La prueba vuelca el
  almacén de un dispositivo, lo carga en otro proveedor vacío y el grupo recargado (`MlsGroup::load`) descifra el
  siguiente mensaje. Un almacén propio respaldado por IndexedDB en la web y por el llavero o un fichero cifrado en
  nativo es el camino natural, con el **mismo crate** compilado a WASM y a Android/iOS (p. ej. con UniFFI).
- Riesgo: el formato de almacenamiento cambia entre versiones (OpenMLS tiene una feature
  `0-8-1-storage-format` para leer el formato anterior). WebView y nativo deben llevar la misma versión de OpenMLS, o
  migrar el almacén al actualizar.
- ts-mls produce un único blob (`encodeGroupState`) fácil de pasar, pero solo existe en JavaScript: el lado nativo
  tendría que ejecutar JS o reimplementar MLS.

## Riesgos abiertos

| Riesgo | Detalle | Qué hacer |
| --- | --- | --- |
| Commits de tamaño lineal tras migrar | ~410 KB por alta/baja a 5.000 miembros con el árbol recién creado | Commit de actualización por dispositivo al entrar; medir estado estacionario en la fase 2 |
| Crear o migrar grupos de miles en el navegador | ~8 s estimados a 5.000 | Web Worker, por tandas o uniones externas; nunca en el hilo principal |
| Peso del WASM | 371 KB brotli | Carga diferida, hash + `immutable`, Service Worker, `wasm-opt` |
| Binding propia | No hay paquete npm oficial de OpenMLS; el de npm es de un tercero | Mantener nuestra binding con `wasm-bindgen`, `Cargo.lock` fijado y compilación reproducible en CI |
| La auditoría no cubre nuestro uso | La auditoría de SRLabs no dice nada del build WASM [1]; el tiempo constante de RustCrypto en WASM no está garantizado por el motor | Incluir la binding y el build WASM en la auditoría externa de la fase 12 |
| API obsoleta | `join_by_external_commit` está marcada obsoleta en 0.9.2 | Usar `external_commit_builder` en la implementación real |
| WebViews antiguos | Android `minSdk 26` con WebView sin actualizar | OpenMLS solo necesita WASM; ts-mls no sirve aquí |
| Safari y WebView reales sin probar | Solo se probó WebKit de Playwright en Windows | Ejecutar la prueba en un iPhone y un Android reales antes de la fase 2 |
| Formato del almacén entre versiones | Cambia entre versiones de OpenMLS | Misma versión en WebView y nativo; migración del almacén en cada subida |

## Reproducir

En `dashboard/experiments/mls-spike/` (necesita Node 20+, Rust con el target `wasm32-unknown-unknown` y
`wasm-bindgen-cli` 0.2.130, y los navegadores de Playwright ya instalados):

1. `npm ci --ignore-scripts`
2. `npm run node`: ts-mls en Node.
3. `npm run openmls:native` y `npm run openmls:wasm`: OpenMLS nativo y build WASM.
4. `node run-browser.mjs chromium openmls 2,50,500,1000 [4]`: navegador headless (`webkit` con `WEBKIT_PATH`
   apuntando al ejecutable de Playwright si la revisión fijada no está descargada).
5. `npm run sizes`: tamaños.

Resultados en bruto: `results/*.jsonl`.

## Fuentes

1. OpenMLS, "OpenMLS security audit", 2026-05-27: https://blog.openmls.tech/posts/2026-05-27-independent-audit/
2. crates.io, openmls: https://crates.io/crates/openmls
3. GitHub, openmls/openmls: https://github.com/openmls/openmls
4. GitHub, awslabs/mls-rs: https://github.com/awslabs/mls-rs
5. mls-rs README (aviso de seguridad, soporte WASM): https://docs.rs/crate/mls-rs/latest/source/README.md
6. Avisos de OpenMLS: https://advisories.gitlab.com/pkg/cargo/openmls/ y https://security.snyk.io/vuln/SNYK-RUST-OPENMLS-15248401
7. ts-mls README (aviso de seguridad, ciphersuites): https://github.com/LukaJCB/ts-mls
8. npm, ts-mls: https://www.npmjs.com/package/ts-mls
9. Electron releases (44.3.0 -> Chrome 152.0.7977.78): https://releases.electronjs.org/releases.json
