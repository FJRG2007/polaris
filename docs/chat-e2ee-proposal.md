# Propuesta: cifrado de extremo a extremo (E2EE) en Polaris Chat

Fecha: 2026-11-21. Estado: propuesta, sin código. Las afirmaciones sobre otros productos llevan la fuente entre corchetes `[n]`; la lista está al final. Lo que es deducción propia aparece marcado como tal.

---

## 0. Veredicto en una página

| Pregunta | Respuesta |
| --- | --- |
| ¿Se puede tener E2EE tipo WhatsApp/Signal sin perder funciones? | Sí para casi todo. Cada función se reubica: o pasa al cliente, o pasa a un **participante explícito** (bot, Polar, webhook) que tiene claves y aparece en la lista de miembros. Así lo hacen WhatsApp con Meta AI y con la Cloud API [5][8][9]. |
| ¿Dónde hay un coste real? | En 4 puntos, y se declaran en pantalla: (1) lo que se le manda a Polar o a un bot lo lee quien ejecuta ese bot, y en un Polaris autoalojado ese es el operador; (2) las vistas previas de enlaces desde el **navegador web** necesitan que el servidor haga la petición y, por tanto, que vea la URL (escritorio y móvil no); (3) el filtrado automático de contenido en el servidor desaparece y se sustituye por denuncias verificables; (4) buscar requiere indexar en cada dispositivo. |
| Protocolo | **MLS (RFC 9420)** para el acuerdo de claves de grupo, con una clave de contenido por época derivada del *exporter* de MLS para mensajes, archivos y llamadas. Coste logarítmico en el tamaño del grupo frente al cuadrático de Sender Keys al expulsar a alguien [21]. Es el patrón que Discord usa en DAVE (MLS para las claves, cifrado de tramas para el medio) [11]. |
| Velocidad y recursos | El **servidor gasta menos**: deja de pedir vistas previas, de indexar texto y de generar miniaturas. El almacenamiento es una sola copia cifrada por mensaje (unos 92 bytes extra: nonce, etiqueta y firma). El **cliente gasta más** en una cosa: el índice de búsqueda local. |
| Recuperar el historial sin ningún dispositivo | **Clave de recuperación** aleatoria (raíz) + **frase de contraseña opcional** derivada con el KDF del Vault + **recuperación social u organizativa opcional** (la clave repartida con Shamir). El historial se guarda cifrado en el servidor como en Labyrinth de Messenger [13][14], y la copia de seguridad solo contiene **claves**, no mensajes. Sin HSM: un servidor autoalojado no tiene un enclave que limite los intentos, y la propuesta lo dice. |
| Tamaño | XL. 12 fases; la primera entrega útil (MD y grupos cifrados, con archivos y notificaciones) son las fases 1-4. Requiere una auditoría externa antes de activarlo por defecto (DAVE la tuvo [11]). |

---

## 1. Modelo de amenazas: qué protege E2EE en un Polaris autoalojado

Polaris lo ejecuta un operador para su organización o su familia. El roadmap (`docs/chat-roadmap.md`, sección 4) plantea que cifrar en reposo ya cubre mucho. E2EE añade protección frente a:

| Amenaza | Cifrado en reposo + TLS | E2EE |
| --- | --- | --- |
| Robo del disco o de una copia de la base de datos | Protege si la clave no se roba con ella | Protege |
| El operador (o quien le robe el acceso de root) lee los chats | No protege | Protege el contenido |
| Una vulnerabilidad en el panel o en una app instalada que lee la tabla de mensajes | No protege | Protege |
| Un administrador de **otra** organización en el mismo servidor | Depende del aislamiento | Protege |
| Metadatos (quién habla con quién, cuándo, tamaños) | No protege | **Tampoco** (el servidor enruta). Sealed sender de Signal reduce una parte [16], pero Polaris necesita la pertenencia a los grupos para los permisos, así que queda fuera. |
| Un servidor malicioso que inyecta un dispositivo falso en tu lista | - | Solo si los dispositivos los firma la identidad del usuario (sección 8) |

Conclusión: en un Polaris autoalojado, E2EE protege sobre todo frente al servidor comprometido y frente a la curiosidad del operador. Por eso cualquier componente que **se ejecute en el servidor** y lea texto plano (Polar, webhooks, bots) tiene que ser un participante visible, nunca una puerta trasera silenciosa.

---

## 2. Cómo lo resuelven los demás

| Producto | Texto E2EE | Cómo encajan IA, bots y funciones | Recuperación del historial |
| --- | --- | --- | --- |
| **WhatsApp** | Signal Protocol; en multidispositivo cada dispositivo tiene su identidad, el emisor cifra N veces en 1:1 y los grupos usan Sender Keys; el móvil firma la clave del dispositivo acompañante [1][2]. | **Meta AI**: solo lee los mensajes que la mencionan o que se le comparten [6]; lo que se le dice a Meta AI no es E2EE [7]. **Private Processing**: la IA se ejecuta en una VM confidencial (TEE) con atestación remota y un relay OHTTP de terceros [3][4], auditada por Trail of Bits y NCC [5][29]. **Cloud API**: Meta guarda las claves en nombre de la empresa; el extremo es la empresa [8][9]. | Copia cifrada con clave de 256 bits generada en el dispositivo, guardada en un **HSM Backup Key Vault** con OPAQUE y límite de intentos, u opción de clave de 64 dígitos [10][30]. |
| **Signal** | Double Ratchet + PQXDH (poscuántico en el saludo inicial) y desde 2025 SPQR / Triple Ratchet con ML-KEM [17][28]. | Sin bots. Las vistas previas las genera el emisor y pasan por un proxy TLS, así que Signal nunca ve la URL [18]. Sealed sender oculta el remitente al servidor [16]. | **PIN + SVR** (enclaves SGX, ahora SVR3 repartido entre varios tipos de enclave) para datos de cuenta [19][20]; **Secure Backups** con clave de 64 caracteres generada en el dispositivo (2025) [15]. |
| **Messenger** | Signal Protocol (2023). | Algunas funciones se rehicieron de cero, como la búsqueda de stickers con credenciales anónimas [12]. | **Labyrinth**: el historial cifrado vive en el servidor y se carga bajo demanda, con rotación de claves al quitar un dispositivo [12][13]; Labyrinth 1.1 (2026) manda cada mensaje al backup al enviarlo [14]. |
| **Discord** | **No**: el texto no es E2EE, por moderación y porque sus funciones asumen texto legible [11]. | Voz y vídeo E2EE con **DAVE** (MLS + WebRTC encoded transforms; el SFU reenvía sin poder descifrar) [11][22]. Desde marzo de 2026 los bots que entran en voz **tienen que implementar DAVE**, es decir, ser participantes con claves [23]. | No aplica. |
| **Telegram** | Los chats en la nube **no** son E2EE (cifrado cliente-servidor); los chats secretos sí, pero solo 1:1, ligados a un dispositivo, sin búsqueda en servidor ni sincronización [24][25]. | Los bots usan la Bot API, que recibe las actualizaciones desde los servidores de Telegram [26]; *deducción*: por eso solo existen donde el servidor tiene el texto, es decir, en chats en la nube. | El chat secreto no se recupera. |
| **Matrix / Element** | Olm (pares) + Megolm (ratchet de grupo por emisor) [31]. | Búsqueda en salas cifradas solo en escritorio, con un índice local (**Seshat**, Rust + Tantivy, SQLCipher) [32][33]. Los bots son dispositivos miembros de la sala. Historial compartido con quien entra nuevo [34]. | Copia de claves en el servidor protegida con **clave de recuperación** (SSSS) [35]; **cross-signing** y verificación SAS por emoji o QR [35][36]. El algoritmo antiguo de backup tiene defectos conocidos [35]. |
| **Wire / Webex / RCS** | MLS en producción (Wire, migrando desde Proteus) [37]; Webex con MLS + SFrame para reuniones [38]; RCS Universal Profile 3.0 adopta MLS y Google Messages lo prueba [39][40]. | - | - |
| **iMessage** | PQ3: poscuántico en el saludo **y** en el ratchet (Apple lo llama nivel 3, frente al nivel 2 de PQXDH) [27]. | Apple Private Cloud Compute: cómputo sin estado y registro de transparencia de lo que ejecutan los nodos [41][42]. | - |

Lección común: **nadie mantiene una función de servidor leyendo texto E2EE**. La reubican en el cliente, en un participante declarado o en un enclave atestado.

---

## 3. Protocolo recomendado

### 3.1 Comparación

| Criterio | Signal (Double Ratchet 1:1 + Sender Keys en grupo, como WhatsApp) | MLS (RFC 9420) |
| --- | --- | --- |
| Coste al cambiar los miembros | Cada emisor redistribuye su sender key por pares: el coste crece con el cuadrado del grupo (lo dice la introducción del RFC) [21] | `log(N)` cifrados a subárboles por commit [21] |
| Seguridad tras compromiso (PCS) en grupo | Débil: una sender key robada sirve hasta que se rota | Nativa: tras un Update/Commit el atacante pierde el acceso [21] |
| Tamaño de grupo objetivo | Grupos pequeños y medianos | "De dos a miles" [21] |
| Multidispositivo | Cada dispositivo cuenta como un destinatario más (fanout N) [2] | Cada dispositivo es una hoja del árbol; el coste sigue siendo logarítmico |
| Llamadas | Clave aparte | El mismo grupo MLS deriva la clave de medios (DAVE) [11][22] |
| Estándar e interoperabilidad | De facto (libsignal) | IETF; RCS, Wire, Webex y Discord lo usan [22][37][38][39] |
| Madurez de bibliotecas | libsignal (AGPL) | OpenMLS (Rust, compila a WASM) y mls-rs de AWS [43][44] |

**Elección: MLS.** Polaris tiene canales de espacio con decenas de miembros, rosters que cambian, varias organizaciones y varios dispositivos por persona. Ese es justo el caso donde Sender Keys se degrada y MLS no. Además, una sola sesión MLS por conversación sirve a la vez para texto, archivos y llamadas.

### 3.2 Diseño concreto

1. **Un grupo MLS por conversación** (MD, grupo, canal). Hojas = dispositivos. El servidor de Polaris hace de *Delivery Service* (ordena y reparte los commits) y guarda el `GroupInfo` público para permitir uniones externas (RFC 9420, external commits).
2. **Credenciales firmadas por el usuario, no por el servidor.** Cada dispositivo presenta una credencial firmada por la *clave de identidad de cuenta* del usuario (sección 8). Así un servidor malicioso no puede colar una hoja que nadie reconozca.
3. **Contenido cifrado con una clave de época** (diseño propio inspirado en DAVE): `K_epoch = MLS-Exporter("polaris/content", epoch)`. Cada mensaje: `K_msg = HKDF(K_epoch, sender_leaf || message_id)`, AES-256-GCM, firmado con la clave de firma MLS del emisor. El servidor guarda **una sola copia** del texto cifrado: es el registro duradero y también lo que se reparte en vivo.
   - Por qué así y no con mensajes de aplicación MLS puros: los secretos de aplicación de MLS se borran por diseño (secreto hacia delante), y entonces el historial que el servidor guarda no lo podría leer un dispositivo nuevo. Matrix y Messenger resuelven eso guardando **las claves** en un backup [13][35]. Aquí ese backup son 32 bytes por época y conversación, no una segunda copia de los mensajes.
   - Coste declarado: dentro de una época no hay secreto hacia delante por mensaje. Las épocas rotan en cada alta o baja y cada pocas horas o días (el RFC recomienda Updates "del orden de horas o días" [21]). Es la misma concesión que hace cualquier sistema con historial recuperable.
   - **Esta construcción es criptografía propia** y necesita revisión externa antes de activarla por defecto.
4. **Ciphersuite inicial**: `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` (0x0001 del RFC). **Poscuántico**: el campo de ciphersuite de MLS permite migrar. Se adopta un suite híbrido con ML-KEM cuando esté estandarizado y soportado por la biblioteca; Signal (PQXDH/SPQR) y Apple (PQ3) muestran que la amenaza "guardar ahora, descifrar después" ya se trata como real [17][27][28].
5. **Compatibilidad entre versiones**: un cliente sin soporte no puede entrar en una conversación cifrada, y lo ve en pantalla con el botón de actualizar. Es lo que hizo Discord con DAVE en marzo de 2026 [23]. Nunca se degrada en silencio a texto en claro.

---

## 4. Mapa de funciones: cómo sigue funcionando cada una

Leyenda de **coste**: `Ninguno` = idéntico para el usuario; `Declarado` = funciona, con una concesión que se explica en pantalla; `Cambia` = la función existe pero se comporta distinto.

### 4.1 Mensajería

| Función actual | Cómo funciona con E2EE | Coste |
| --- | --- | --- |
| Texto, Markdown, texto enriquecido | Se cifra el documento entero; se renderiza en el cliente como ahora | Ninguno |
| Editar e historial de ediciones | Una edición es un mensaje cifrado que apunta al `message_id` original; el historial son las versiones cifradas | Ninguno |
| Borrar para todos | El servidor borra el texto cifrado (ve el id, no el contenido) y los clientes borran su copia local | Ninguno |
| Reacciones, respuestas, hilos | Reacción = mensaje cifrado pequeño. El id del padre de un hilo viaja en claro (es metadato de estructura), el contenido no | Ninguno |
| Menciones @persona / @sala y niveles de aviso (`notify.ts`, `room-mentions.ts`) | El emisor adjunta en claro la **lista de ids mencionados** para que el servidor pueda aplicar niveles y silencios. El texto sigue cifrado | Declarado: el servidor sabe a quién se menciona, no qué se dice. Hay un modo estricto opcional: el servidor despierta al destinatario en cada mensaje y la decisión se toma en el dispositivo |
| Reenviar | Se reutiliza el texto cifrado del archivo con su misma clave (sin volver a subirlo); el texto se cifra para la conversación de destino | Ninguno |
| Encuestas (`polls.ts`) | Pregunta y opciones cifradas; cada voto es un mensaje cifrado; el recuento se hace en el cliente | Cambia: no hay recuento en el servidor (no se necesitaba) |
| Mensajes programados (`scheduled.ts`) | El cliente cifra al programar con la clave de la época actual; el servidor guarda el blob y lo publica a su hora. Si la época cambia antes (alguien entra o sale), el servidor avisa al dispositivo del autor para que lo vuelva a cifrar; si no hay ninguno en línea, se publica con la época antigua y los miembros nuevos reciben esa clave por el historial compartido (4.5) | Declarado: un expulsado entre programar y enviar **no** recibe el mensaje porque la época antigua no se le reparte; lo que se reparte es solo a los miembros vigentes |
| Borradores (`drafts.ts`) | Cifrados con una clave personal del usuario | Ninguno |
| Mensajes temporales (roadmap) | Temporizador dentro del texto cifrado; los clientes borran y el servidor borra el blob a la hora indicada | Ninguno |
| Fijados y guardados (`saved-media.ts`) | El servidor guarda la referencia; el contenido ya está cifrado | Ninguno |
| Avisos de entrada y salida, llamadas perdidas (`notices.ts`, `missed-call.ts`) | Los genera el servidor a partir de metadatos que ya conoce, y siguen así | Ninguno |
| Referencias a tareas (`PLR-42`, `references.ts`) | La resolución pasa al cliente: el cliente reconoce la referencia y pide la tarea a la API de Tasks con sus propios permisos. Tasks no es E2EE | Ninguno |
| GIF (Tenor, `tenor.ts`) | La búsqueda sigue por el proxy de Polaris (la consulta la ven el servidor y Tenor, como hoy); el emisor descarga el GIF elegido y lo sube cifrado como un archivo más | Ninguno respecto a hoy |
| Emojis propios | Recursos de la organización, no contenido del chat: siguen igual | Ninguno |
| No leídos, confirmaciones de lectura, escribiendo | Metadatos que el servidor ya maneja | Ninguno |
| Aislamiento entre organizaciones (`isolation.ts`) | Igual. MLS añade además que un administrador de otra organización no puede leer | Mejora |

### 4.2 Archivos y visores

| Función | Con E2EE | Coste |
| --- | --- | --- |
| Adjuntos (`attachments.ts`) | Una clave aleatoria AES-256-GCM por archivo, cifrado en **bloques** (64 KiB) para poder reproducir y descargar por rangos; la clave y el SHA-256 del texto en claro van dentro del mensaje cifrado. El almacén (local, NAS, S3) solo ve blobs | Ninguno |
| Visor de imágenes, audio y vídeo (`attachment-viewer.tsx`) | Un Service Worker descifra los rangos y sirve una URL local (`blob:` o una ruta del propio SW), y el visor recibe eso en lugar de la URL del servidor. El vídeo largo se reproduce por rangos | Ninguno; la descarga ya era necesaria |
| PDF, hojas (Univer) y documentos | Los editores aceptan bytes en lugar de una URL: el roadmap ya lo señala como el trabajo de fondo | Ninguno, con trabajo en cada visor |
| Miniaturas y posters (`readAttachmentPoster`) | Los genera el **emisor** y se suben cifrados junto al archivo | Ninguno; el servidor deja de hacerlo |
| Guardar en Drive | El cliente descifra y sube a Drive. Drive no es E2EE y el botón lo dice | Declarado |
| Clips de voz y vídeo (`clip-recorder.ts`) | Ya se graban en el cliente; se cifran como cualquier archivo | Ninguno |
| Retención y limpieza (`tidyChatStorage`) | Siguen funcionando por ids y tamaños | Ninguno |
| Deduplicación entre conversaciones | Se pierde (cada archivo lleva su propia clave), salvo al reenviar, que reutiliza el mismo blob | Mínimo |

### 4.3 Vistas previas e incrustaciones

Hoy el servidor pide la página a través de `safe-fetch` (`link-preview.ts`) y protege al lector sirviendo la imagen desde Polaris. Con E2EE la tarjeta la **genera el emisor** y viaja cifrada dentro del mensaje (título, descripción y miniatura como adjunto cifrado). Los lectores nunca hacen la petición. Así lo hacen Signal, WhatsApp, iMessage y Wire [18][45][46].

| Cliente que envía | Cómo obtiene la página | Quién ve la URL |
| --- | --- | --- |
| Escritorio y móvil (proceso nativo) | Petición directa desde el dispositivo, sin CORS | La web de destino (ve la IP del emisor, igual que en Signal sin su proxy). Opcional: túnel por el servidor sin descifrar TLS, al estilo Signal [18] |
| Navegador web | El navegador no puede abrir TLS crudo ni saltarse CORS, así que la petición la hace el servidor (`safe-fetch` tal como está) | Declarado: **el servidor ve la URL** y quién la pidió, no la conversación en que se pega. Se puede desactivar por conversación |
| oEmbed y reproductor de YouTube (`embeds.ts`) | La tarjeta la genera el emisor; el reproductor contacta con YouTube solo al pulsar Play | Ninguno respecto a hoy |

### 4.4 Búsqueda

| Ámbito | Con E2EE | Coste |
| --- | --- | --- |
| Buscar en el chat (`lib/chat/search.ts`, `lib/search/*`) | **Índice local** sobre el almacén offline en IndexedDB que se está construyendo: índice invertido de los mensajes descifrados, guardado cifrado con una clave del dispositivo. En escritorio puede usar un índice nativo, como Seshat en Element (Tantivy con un heap de escritura de 50 MB y SQLCipher) [32][33] | Cambia: cada dispositivo indexa lo suyo |
| Dispositivo nuevo | Descarga el texto cifrado, lo descifra con las claves del backup e indexa en segundo plano: primero lo reciente y luego hacia atrás. Mientras tanto la búsqueda dice hasta qué fecha llega | Declarado: el primer índice tarda y consume batería; se limita a la Wi-Fi y a la carga en móvil |
| Navegador web efímero (sin almacenamiento persistente) | Busca solo en lo cargado y lo dice | Declarado |
| Búsqueda global (personas, tareas, páginas) | Sin cambios: no es contenido del chat | Ninguno |
| Cifrado buscable en el servidor | **Descartado.** Los esquemas buscables filtran patrones de acceso y frecuencias; ningún mensajero de los citados los usa. Es la razón por la que Element indexa en local [32] | - |

### 4.5 Miembros, invitaciones y moderación

| Función | Con E2EE | Coste |
| --- | --- | --- |
| Añadir personas (`add-people-dialog.tsx`) | El dispositivo de quien añade hace un Commit MLS `Add` con los KeyPackages del invitado | Ninguno |
| Enlaces de invitación (`invites.ts`) | El invitado hace un **external commit** con el `GroupInfo` que publica el servidor, sin esperar a que haya un miembro en línea. El servidor solo acepta el commit si la invitación es válida | Ninguno |
| Historial para quien entra | Un miembro comparte las claves de época del historial visible (como el historial compartido de Element [34]). Política por conversación: "desde que entró" o "todo" | Ninguno; ya existe esa decisión |
| Expulsar y banear (`bans-dialog.tsx`) | El servidor bloquea al instante (permiso) y el primer dispositivo de un administrador en línea emite el Commit `Remove`; hasta entonces el servidor no reparte nada nuevo al expulsado | Ninguno |
| Denunciar un mensaje (`reports.ts`, `report-files.ts`) | **Message franking** (Facebook): el emisor incluye un compromiso `HMAC(k_f, texto)` visible para el servidor, que lo sella con su propia clave, el remitente y la hora al recibirlo. Quien denuncia revela el texto y `k_f`, y el moderador comprueba que ese mensaje se envió así [47][48]. Para los archivos se compromete el SHA-256 del texto en claro, porque AES-GCM no compromete la clave y el franking de adjuntos de Facebook se pudo burlar por eso [49] | Declarado: el moderador ve **solo lo que el denunciante le envía**; el contexto adjunto lo elige el denunciante y puede omitir mensajes [50]. Tampoco hay escaneo automático en el servidor |
| Filtros automáticos de contenido | No existen con E2EE; se sustituyen por filtros locales opcionales en el cliente y por denuncias | Declarado |

### 4.6 Notificaciones

| Plataforma | Con E2EE | Coste |
| --- | --- | --- |
| Web (pestaña y Service Worker) | El push lleva `{conversationId, messageId}` y el texto cifrado si cabe; el payload de Web Push ya va cifrado hasta el navegador (RFC 8291) [51]. El SW descifra con las claves locales y muestra el texto | Ninguno |
| Escritorio | La app descifra antes de llamar a `desktop-notify` | Ninguno |
| iOS | Una **Notification Service Extension** descifra el payload antes de mostrarlo [52]. Requiere que el estado de claves viva en un contenedor nativo compartido (App Group), no solo en el IndexedDB del WebView | Trabajo nativo real |
| Android | Un mensaje de solo datos despierta un manejador nativo que descifra y construye la notificación [53]. El estado de claves vive en almacenamiento nativo | Trabajo nativo real |
| Si el descifrado falla (estado no disponible) | Se muestra "Mensaje nuevo de *Nombre*" con el nombre sacado de los metadatos | Declarado |

### 4.7 Llamadas y reuniones

| Función | Con E2EE | Coste |
| --- | --- | --- |
| Audio y vídeo (LiveKit, `livekit-client` 2.22.0) | LiveKit soporta E2EE de medios y datos, por sala, y LiveKit "no guarda ni transporta las claves" [54]. Con un **key provider propio** (`onSetEncryptionKey` por identidad y ratchet [55]) se inyectan claves por emisor derivadas del exporter MLS de la conversación, igual que DAVE [11]. El cliente web necesita el worker `livekit-client/e2ee-worker` [55] | Ninguno para el usuario |
| Rotación al entrar o salir alguien | Commit MLS -> nueva época -> claves nuevas. DAVE muestra un "Voice Privacy Code" que cambia en cada cambio de época [11] | Ninguno |
| Grabación (`call-recorder`) | Ya se graba en el navegador de quien pulsa: sigue igual | Ninguno |
| Combinar audio, fondos virtuales, supresión de ruido | Ya son de cliente | Ninguno |
| Chat de reunión (`meeting-chat.ts`) | Grupo MLS de la reunión. Los invitados sin cuenta reciben claves de sesión efímeras | Ninguno |
| Señalización y API de LiveKit | Solo TLS: el servidor de LiveKit las puede leer [54] (quién está en la sala, no lo que se dice) | Metadato, como hoy |
| Compatibilidad de navegadores | Depende de WebRTC encoded transforms; la doc de LiveKit no lista los navegadores [54][55]. **Sin verificar: hay que probar Safari, Firefox y el WebView de Android/iOS antes de comprometerse** | Por verificar |
| Procesado futuro en servidor (transcripción, egress) | No es posible sin un participante declarado ("Transcriptor" visible en la llamada), igual que los bots en DAVE [23] | Declarado |

### 4.8 Polar, automatizaciones, bots y componentes

El principio: **lo que corre en el servidor es un participante, se ve en la lista de miembros y tiene sus propias claves.** Nunca una lectura silenciosa.

| Función | Con E2EE | Coste |
| --- | --- | --- |
| **Polar en el chat, modo mención (por defecto)** | Polar **no** es miembro del grupo MLS. Cuando alguien escribe `@Polar` o `/polar`, su cliente manda a Polar solo ese mensaje y el contexto que el usuario elige (por ejemplo, "los últimos 20 mensajes") por un canal cifrado hasta Polar. Polar responde, el cliente del invocador publica la respuesta en la conversación y la respuesta va firmada por Polar. Es el modelo de Meta AI: lee solo lo que la menciona o lo que se le comparte [6] | Declarado: lo que se le pasa a Polar lo puede leer el servidor que lo ejecuta (el operador) y el proveedor del modelo, igual que lo que se dice a Meta AI no es E2EE [7]. La interfaz enseña "Compartirás N mensajes con Polar" |
| **Polar como miembro (opcional por conversación)** | Para resúmenes y respuestas proactivas: un administrador añade a Polar como una hoja MLS más, visible en la lista con la insignia "Puede leer los mensajes". Al quitarlo, Commit `Remove` | Declarado y visible |
| Polar con clave propia del usuario (BYOK) | Desde escritorio o móvil, el cliente puede llamar al proveedor directamente y el servidor de Polaris no ve el texto (el proveedor sí) | Opción |
| Polar en TEE | Private Processing de Meta y Private Cloud Compute de Apple ejecutan la IA en VMs confidenciales con atestación y transparencia [3][4][41][42]. En Polaris solo sería posible en hardware con AMD SEV-SNP o Intel TDX y con un modelo **local** dentro del TEE (un proveedor externo vuelve a ver el texto). Un servidor doméstico casi nunca lo tiene, y la ACLU señala que la atestación depende de la firma del fabricante [56] | No recomendado como base; se deja como mejora opcional |
| **Webhooks entrantes y automatizaciones** (`webhook-sender.ts`, avisos de deploy) | Cada webhook es un **miembro de servicio** ("Automatización: Deploy") cuyas claves guarda el servidor. Recibe el contenido por HTTPS y lo cifra para el grupo. Es exactamente el modelo de la WhatsApp Cloud API, donde Meta guarda las claves de la empresa [8] | Ninguno real: ese contenido ya nace en el servidor |
| Bots que leen la conversación | Miembro con claves, visible, con alcance elegible: "solo menciones" (como Polar) o "todos los mensajes". Telegram lo evita restringiendo los bots a chats no cifrados [24][26]; aquí se declara | Declarado y visible |
| **Componentes de mensaje** (botones, formularios) y comandos de app (`/task`) | La definición del componente va dentro del mensaje cifrado. Pulsar envía una interacción cifrada **solo al bot dueño** (un canal 1:1 con ese miembro), no a la fila guardada en el servidor. Un comando de app que crea una tarea lo ejecuta el cliente contra la API de Tasks y publica el resultado cifrado | Cambia por dentro; igual para el usuario |
| Mensajes automáticos con plantillas (`notice-text.ts`) | Si los genera el servidor, el emisor es un miembro de servicio, como los webhooks | Ninguno |

### 4.9 Plataforma

| Función | Con E2EE | Coste |
| --- | --- | --- |
| Exportar e importar Polaris completo | La exportación lleva el texto cifrado tal cual; para que la importación sea plug-and-play el usuario necesita su clave de recuperación. Exportación legible: desde el cliente | Declarado |
| Estadísticas de consumo de administración | Tamaños y recuentos: siguen | Ninguno |
| Archivo legal de una organización | Opción por organización: un miembro "Archivo de la organización", visible en todas sus conversaciones, que recibe una copia. Es transparente, nunca oculto. Por defecto, desactivado | Declarado |
| Versiones antiguas de clientes (escritorio, extensión, móvil) | Las conversaciones cifradas exigen una versión mínima; los clientes antiguos ven "Actualiza para abrir esta conversación" | Declarado |

---

## 5. Copia de seguridad y recuperación

### 5.1 Qué se guarda

- **En el servidor, como hoy**: el texto cifrado de cada mensaje y archivo. No hay una segunda copia: el historial **es** el registro cifrado (el patrón Labyrinth [13]).
- **En el backup de claves del usuario** (también en el servidor, cifrado): la clave de identidad de cuenta, las claves de época de cada conversación (32 bytes cada una) y la clave del índice. Se actualiza **al recibir cada época nueva**, sin esperar a reconectar, como en Labyrinth 1.1 [14].
- El backup cifra todo con una **clave de backup** aleatoria de 256 bits, y esa clave se envuelve con uno o varios "cierres".

### 5.2 Opciones de cierre

| Cierre | Cómo funciona | Fortaleza en un Polaris autoalojado | Quién lo usa |
| --- | --- | --- | --- |
| **Clave de recuperación** | 256 bits aleatorios mostrados como grupos de caracteres (unos 64) y como QR, para guardarlos en el Vault o en papel | La más fuerte: el servidor no puede atacarla | Signal Secure Backups (64 caracteres) [15], Element [35], WhatsApp (64 dígitos) [10] |
| **Frase de contraseña con KDF** (reutiliza el Vault) | La clave de backup se envuelve con una clave derivada de la frase, con los mismos `KdfSettings` de `packages/core/src/vault.ts` (PBKDF2 por defecto hoy; Argon2id recomendado para esto) y las reglas de `password-safety-rules` | Media: quien tenga la base de datos (incluido el operador) puede probar contraseñas **sin límite**. Aceptable solo con una frase fuerte | Modelo Bitwarden/Vault |
| **HSM o enclave con límite de intentos** (PIN corto) | El enclave entrega la clave tras un PIN correcto y se autodestruye tras N fallos | **No disponible**: un servidor doméstico no tiene HSM, y un TPM lo controla el mismo operador del que nos protegemos | WhatsApp HSM Vault con OPAQUE [10][30], Signal SVR/SVR3 [19][20] |
| **Recuperación social u organizativa** | La clave de recuperación se reparte con Shamir (por ejemplo 2 de 3) entre contactos de confianza o administradores de la organización; cada parte va cifrada para ellos | Buena si los custodios no se conchaban; encaja con el concepto de sucesor que ya tiene Polaris | Variante de los esquemas de umbral |
| **Otro dispositivo propio** | Un dispositivo verificado entrega las claves al nuevo (QR) | La mejor experiencia; no sirve si se pierden todos | WhatsApp, Matrix [2][35] |

### 5.3 Recomendación

1. Al activar E2EE se genera **siempre** la clave de recuperación. Un botón la guarda en el Vault del propio usuario: el Vault es zero-knowledge, así que no se debilita nada y quien tiene Vault ya tiene dónde guardarla.
2. **Frase de contraseña opcional**, con Argon2id y un medidor de fuerza que rechaza las débiles. La pantalla explica en una línea que protege menos que la clave.
3. **Custodios opcionales** (contactos o administradores), con Shamir.
4. Cualquier dispositivo verificado sirve también como cierre.

### 5.4 He perdido todos mis dispositivos: el recorrido

1. Inicia sesión en un dispositivo nuevo (contraseña de la cuenta y 2FA, como hoy).
2. Polaris detecta que hay un backup de claves y pide **uno** de: la clave de recuperación (escribir o escanear el QR), la frase de contraseña o "pedir ayuda a mis custodios".
3. Con custodios: cada custodio recibe una petición en Polaris, confirma (idealmente por otro canal, con un código de verificación) y su dispositivo devuelve su parte cifrada para el dispositivo nuevo. Con el umbral alcanzado se reconstruye la clave.
4. El dispositivo descifra el backup, recupera la identidad de cuenta y firma su propia credencial de dispositivo; los contactos ven "Ana añadió un dispositivo" (no "la identidad de Ana cambió").
5. Descarga el historial cifrado bajo demanda, lo muestra al momento (SWR desde la caché local en cuanto existe) e indexa la búsqueda en segundo plano.
6. Si no tiene **ninguno** de los cierres: puede seguir usando la cuenta con una identidad nueva, los contactos ven el aviso de cambio de identidad y el historial cifrado anterior es irrecuperable. La pantalla de activación lo dice antes, no después.

---

## 6. Verificación de dispositivos

| Elemento | Diseño | Precedente |
| --- | --- | --- |
| Identidad de cuenta | Un par de claves por usuario que firma cada dispositivo (cross-signing) | Matrix [35][36], firma de cuenta de WhatsApp [1] |
| Añadir un dispositivo | Se aprueba con el QR desde un dispositivo existente; se **reutiliza el flujo de inicio de sesión por QR** que Polaris ya tiene. Alternativa: la clave de recuperación | WhatsApp, Element |
| Confianza por defecto | TOFU: la primera identidad vista se acepta y cualquier cambio de **identidad** (no de dispositivo) se marca en la conversación | Verificación automática de dispositivos de WhatsApp [1] |
| Verificar a alguien | Comparar un número de seguridad o escanear un QR en persona; también 7 emojis (SAS) por videollamada. Queda una insignia de "verificado" | Signal, Matrix SAS [36], código de verificación de DAVE [11] |
| Organizaciones | Un administrador puede marcar identidades como verificadas para su organización (opcional) | - |
| Transparencia de claves | Fase posterior: registro de solo-añadir de las claves de identidad para detectar si el servidor da claves distintas a distintas personas | WhatsApp Key Transparency [57] |

---

## 7. Migración del historial existente

| Opción | Qué hace | Honestidad |
| --- | --- | --- |
| A. Línea en el historial (por defecto) | Lo anterior queda como estaba, legible por el servidor; una línea dice "A partir de aquí, cifrado de extremo a extremo" (lo que el roadmap ya propone, al estilo Element) | Exacta |
| B. Recifrar lo anterior (opcional, por conversación) | El cliente de un miembro descarga lo antiguo, lo cifra con una clave de época "histórica", lo sube y el servidor borra el texto en claro, sus índices y las vistas previas. Es resumible y se hace en segundo plano por lotes | El servidor **ya vio** ese texto, y las copias de seguridad del operador pueden conservarlo. Protege frente a un robo futuro de la base de datos, no hacia atrás. La pantalla lo dice |
| Adjuntos antiguos | Igual que B, archivo a archivo, con el mismo cursor | Igual |
| Activación | Fase 1: MD y grupos con opción por conversación. Fase final: **activado por defecto** en MD y grupos nuevos, y después en canales de espacio | - |

---

## 8. Rendimiento y recursos

| Dimensión | Hoy | Con E2EE | Fuente o cálculo |
| --- | --- | --- | --- |
| Coste de un cambio de miembros en un grupo de N dispositivos | - | `log2(N)` cifrados (N=1.000 -> unos 10) frente a O(N^2) con Sender Keys | RFC 9420 [21] |
| Fanout de un mensaje | 1 escritura y reparto | 1 escritura y reparto (una sola copia cifrada; nada de N copias por dispositivo como el 1:1 de WhatsApp [2]) | Diseño 3.2 |
| Tamaño extra por mensaje | 0 | unos 92 B (nonce de 12 + etiqueta de 16 + firma Ed25519 de 64) | Constantes de AES-GCM y Ed25519 |
| CPU del servidor | Vistas previas, índice de búsqueda, posters | Baja: no descifra, no indexa y no genera miniaturas; solo valida commits | Deducción |
| Backup de claves | - | 32 B por época y conversación | Diseño 5.1 |
| CPU del cliente | Render | + AES-GCM con aceleración por hardware (despreciable por mensaje) + indexar | - |
| Índice de búsqueda local | - | Del orden del tamaño del texto; Seshat usa 50 MB de heap al escribir [33] | [33] |
| Medios en llamadas | SFU reenvía | SFU reenvía igual; el cifrado de tramas va en el cliente; DAVE apunta a "unos cientos de ms" hasta el primer medio [11] | [11] |
| Primer arranque de un dispositivo nuevo | Instantáneo | Instantáneo para lo reciente; el índice completo tarda (en segundo plano) | - |

El requisito "sin más recursos" se cumple en el servidor y en el almacenamiento. En el cliente hay un coste nuevo e inevitable, el índice de búsqueda, y la propuesta lo acota: primero lo reciente, en segundo plano, y en móvil solo con Wi-Fi y cargando.

---

## 9. Plan por fases

Tamaños: S, M, L, XL (relativos). Las dependencias van en orden; las fases 5-9 pueden ir en paralelo cuando la 4 esté hecha.

| Fase | Contenido | Tamaño | Depende de |
| --- | --- | --- | --- |
| 0 | Modelo de amenazas firmado, prueba técnica de OpenMLS o mls-rs en WASM dentro del navegador, Electron y el WebView de Android/iOS; medir peso y tiempo de arranque; revisión de dependencias | S | - |
| 1 | Identidad de cuenta, claves de dispositivo, cross-signing, aprobación por QR (reusando el flujo de QR), clave de recuperación, backup de claves con el KDF del Vault, custodios | L | 0 |
| 2 | Grupos MLS para MD y grupos: Delivery Service en el servidor, cifrado de contenido por época, edición, reacciones, respuestas, encuestas, programados, borradores, temporales; esquema de metadatos en claro mínimo | XL | 1 |
| 3 | Adjuntos cifrados por bloques, Service Worker de descifrado por rangos, visores con bytes (imagen, audio, vídeo, PDF, hojas), miniaturas en el emisor | L | 2 |
| 4 | Notificaciones: Web Push con descifrado en el SW, escritorio, extensión nativa de iOS y manejador de Android con estado de claves compartido | L | 2 |
| 5 | Búsqueda local sobre el almacén offline, rellenado de dispositivos nuevos, estado "indexado hasta" | M | 2 y almacén offline |
| 6 | Vistas previas en el emisor (nativa directa; web vía servidor y declarado), GIF recifrados | M | 3 |
| 7 | Polar en modo mención y como miembro, miembros de servicio para webhooks, bots con alcance, interacciones de componentes y comandos de app | L | 2 |
| 8 | Denuncias con franking y compromiso de archivos, vista de moderación | M | 2, 3 |
| 9 | Llamadas: key provider de LiveKit alimentado por el exporter MLS, código de privacidad de llamada, prueba en todos los navegadores y WebViews | M | 2 |
| 10 | Canales de espacio (grupos grandes), external commits para enlaces de invitación, historial compartido para quien entra, archivo de organización opcional | L | 2, 7 |
| 11 | Migración: línea en el historial y recifrado opcional; activación por defecto en MD y grupos; versión mínima de cliente | M | 1-10 |
| 12 | Auditoría criptográfica externa del diseño 3.2 y de la implementación; transparencia de claves y suite poscuántico cuando esté disponible | Externo | 11 |

Primera entrega útil: fases 0-4 (MD y grupos cifrados con archivos y notificaciones), con Polar, bots y búsqueda **desactivados dentro de las conversaciones cifradas y anunciado al activarlo**, hasta que lleguen las fases 5 y 7.

---

## 10. Riesgos y preguntas abiertas

| Riesgo | Mitigación |
| --- | --- |
| Criptografía propia en la capa de contenido (3.2) | Mantenerla mínima (exporter + HKDF + AEAD + firma), con vectores de prueba y auditoría externa antes de activarla por defecto |
| Soporte de encoded transforms en Safari y en los WebViews | Verificar en la fase 0/9. Si falta, la llamada no se une en silencio sin cifrar: avisa |
| Estado MLS compartido entre el WebView y el código nativo (notificaciones) | Diseñar el almacenamiento de claves en nativo desde la fase 1, no solo en IndexedDB |
| Pérdida de historial por clave perdida | Clave guardada en el Vault con un clic, custodios y aviso claro antes de activar |
| Conflictos de commits concurrentes | El servidor ordena los commits por época (papel de Delivery Service del RFC) y rechaza los obsoletos |
| Biblioteca MLS en WASM: tamaño y cadena de suministro | Medir en la fase 0; fijar la versión en el lockfile; evaluar OpenMLS frente a mls-rs |

---

## Fuentes

1. WhatsApp Security Whitepaper (multidispositivo, firma de cuenta, verificación automática) - https://www.whatsapp.com/security/WhatsApp-Security-Whitepaper.pdf
2. Meta Engineering, "How WhatsApp enables multi-device capability" (2021) - https://engineering.fb.com/2021/07/14/security/whatsapp-multi-device/
3. Meta Engineering, "Building Private Processing for AI tools on WhatsApp" (2025) - https://engineering.fb.com/2025/04/29/security/whatsapp-private-processing-ai-tools/
4. Meta, Private Processing technical whitepaper - https://ai.meta.com/static-resource/private-processing-technical-whitepaper
5. Trail of Bits, "What we learned about TEE security from auditing WhatsApp's Private Inference" (2026) - https://blog.trailofbits.com/2026/04/07/what-we-learned-about-tee-security-from-auditing-whatsapps-private-inference/
6. Factly, cita del Centro de ayuda de WhatsApp sobre Meta AI (solo menciones o lo compartido) - https://factly.in/meta-ai-cannot-access-whatsapp-groups-individual-chats-or-contact-details-the-viral-claim-is-fake
7. EFF, "What WhatsApp's Advanced Chat Privacy really does" (2025) - https://www.eff.org/deeplinks/2025/09/what-whatsapps-advanced-chat-privacy-really-does
8. Meta for Developers, WhatsApp Business Platform: Data Privacy & Security (Cloud API guarda las claves) - https://developers.facebook.com/documentation/business-messaging/whatsapp/data-privacy-and-security
9. WhatsApp Business Platform overview - https://developers.facebook.com/documentation/business-messaging/whatsapp/about-the-platform
10. Meta Engineering, "WhatsApp end-to-end encrypted backups" (2021) - https://engineering.fb.com/2021/09/10/security/whatsapp-e2ee-backups/
11. Discord, "Meet DAVE: E2EE for audio & video" - https://discord.com/blog/meet-dave-e2ee-for-audio-video
12. Meta Engineering, "Building end-to-end security for Messenger" (2023) - https://engineering.fb.com/2023/12/06/security/building-end-to-end-security-for-messenger/
13. Meta, "The Labyrinth Encrypted Message Storage Protocol" (whitepaper, 2023) - https://engineering.fb.com/wp-content/uploads/2023/12/theLabyrintHencryptedMessagestorageProtocol_12-6-2023.pdf
14. Meta Engineering, "Labyrinth 1.1" (2026) - https://engineering.fb.com/2026/05/11/security/labyrinth-1-1-end-to-end-encrypted-e2ee-backups-more-reliable/
15. Signal, "Introducing Signal Secure Backups" (2025) - https://signal.org/blog/introducing-secure-backups/
16. Signal, "Technology preview: Sealed sender for Signal" - https://signal.org/blog/sealed-sender/
17. Signal, "Signal Protocol and Post-Quantum Ratchets" (SPQR) - https://signal.org/blog/spqr/
18. Signal, "I link therefore I am" (vistas previas por proxy) - https://signal.org/blog/i-link-therefore-i-am/
19. Signal, "Technology Preview for secure value recovery" - https://signal.org/blog/secure-value-recovery/
20. Connell et al., SVR3, OSDI 2024 - https://usenix.org/system/files/osdi24-connell.pdf
21. RFC 9420, The Messaging Layer Security (MLS) Protocol - https://www.rfc-editor.org/rfc/rfc9420.html
22. DAVE protocol (especificación) - https://daveprotocol.com/
23. Discord Support, DAVE obligatorio para clientes y bots desde marzo de 2026 - https://support.discord.com/hc/en-us/articles/38025123604631/
24. Telegram FAQ (chats en la nube y chats secretos) - https://telegram.org/faq
25. Telegram, End-to-End Encryption, Secret Chats - https://core.telegram.org/api/end-to-end
26. Telegram Bot API (interfaz HTTP vía servidores de Telegram) - https://core.telegram.org/bots/api
27. Apple Security Research, "iMessage with PQ3" - https://security.apple.com/blog/imessage-pq3/
28. Dodis et al., Triple Ratchet (ePrint 2025/078) - https://eprint.iacr.org/2025/078
29. NCC Group, revisión de WhatsApp message summarization (2025) - https://www.fox-it.com/media/ymskbe40/ncc_group_metaplatforms_whatsapp-message_summarization_report_2025-08-27_v10.pdf
30. Meta Engineering, HSM-based Backup Key Vault (2026) - https://engineering.fb.com/2026/05/01/security/meta-strengthening-end-to-end-encrypted-backups/
31. Matrix spec, Olm y Megolm - https://spec.matrix.org/v1.19/olm-megolm/
32. Documentación de Element (KIT): búsqueda en salas cifradas solo en escritorio - https://docs.matrix.kit.edu/en/messaging/search/
33. Código fuente de Seshat 4.3.0 (Tantivy, heap de escritura de 50 MB) - https://docs.rs/crate/seshat/4.3.0/source/src/index/mod.rs
34. Element, "Seamless encrypted history sharing arrives in Element" - https://element.io/blog/seamless-encrypted-history-sharing-arrives-in-element
35. MSC1946 Secure Secret Storage and Sharing - https://github.com/matrix-org/matrix-spec-proposals/blob/main/proposals/1946-secure_server-side_storage.md ; matrix-sdk-crypto backups (aviso sobre el algoritmo antiguo) - https://docs.rs/crate/matrix-sdk-crypto/latest/source/src/backups/mod.rs
36. Matrix, E2EE cross-signing - https://matrix.org/docs/older/e2ee-cross-signing/
37. Wire, "Wire MLS is now generally available" - https://wire.com/en/blog/wire-mls-is-now-generally-available ; migración desde Proteus - https://support.wire.com/hc/en-us/articles/18666343787293-Migration-from-Proteus-to-MLS-protocol
38. Webex, "How MLS enables scalable end-to-end security in Webex" - https://blog.webex.com/hybrid-work/scalable-end-to-end-security-in-webex/
39. IETF, "RCS adopts MLS" - https://www.ietf.org/blog/rcs-adopts-mls/
40. 9to5Google, Google Messages prueba MLS para RCS (2025) - https://9to5google.com/2025/07/16/google-messages-rcs-mls/
41. Apple Security Research, "Private Cloud Compute" - https://security.apple.com/blog/private-cloud-compute/
42. Apple Security Research, "Expanding Private Cloud Compute" - https://security.apple.com/blog/expanding-pcc
43. OpenMLS - https://github.com/openmls/openmls
44. mls-rs (AWS Labs) - https://github.com/awslabs/mls-rs
45. MacRumors, vistas previas generadas por el emisor en iMessage y WhatsApp - https://www.macrumors.com/2020/10/26/link-previews-may-lead-to-security-vulnerabilities/
46. Wire Support, "Understand link previews" - https://support.wire.com/hc/en-us/articles/115005707945-Understand-link-previews
47. Grubbs, Lu, Ristenpart, "Message Franking via Committing Authenticated Encryption" (ePrint 2017/664) - https://eprint.iacr.org/2017/664
48. Facebook Messenger Secret Conversations whitepaper (franking) - https://fr.slideshare.net/AlbertoSndel/secret-conversations-whitepaper1
49. Dodis, Grubbs, Ristenpart, Woodage, "Fast Message Franking" (ePrint 2019/016) - https://eprint.iacr.org/2019/016
50. "Transcript Franking for Encrypted Messaging" (2025) - https://arxiv.org/pdf/2507.19391
51. RFC 8291, Message Encryption for Web Push - https://www.rfc-editor.org/rfc/rfc8291
52. Apple Developer, UNNotificationServiceExtension - https://developer.apple.com/documentation/usernotifications/unnotificationserviceextension
53. Firebase, mensajes de notificación y de datos - https://firebase.google.com/docs/cloud-messaging/concept-options
54. LiveKit docs, Encryption overview - https://docs.livekit.io/transport/encryption/
55. LiveKit docs, Encryption: get started (ExternalE2EEKeyProvider, key provider propio, worker) - https://docs.livekit.io/transport/encryption/start.md
56. ACLU, "Secure messaging and AI don't mix" - https://www.aclu.org/news/privacy-technology/secure-messaging-and-ai-dont-mix
57. WhatsApp Key Transparency Whitepaper - https://www.whatsapp.com/security/WhatsApp-Key-Transparency-Whitepaper.pdf

### Fuentes que no se pudieron leer enteras

- Las fuentes 6, 29, 30, 48, 52 y 53 se citan por resúmenes de búsqueda o por fragmentos, no por una lectura completa; antes de usarlas como cita textual conviene abrirlas.
- La compatibilidad de navegadores con el E2EE de LiveKit no aparece en sus docs y está **sin verificar**.
