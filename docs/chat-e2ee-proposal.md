# Propuesta v2: cifrado de extremo a extremo (E2EE) en Polaris Chat

Fecha: 2026-11-21. Estado: propuesta; la fase 0 está hecha ([chat-e2ee-phase0.md](chat-e2ee-phase0.md)). Sustituye a la v1 de este mismo archivo (historial de git). Las afirmaciones sobre otros productos llevan la fuente entre corchetes `[n]`; las fuentes 1-57 son las de la v1 y se mantienen con el mismo número, las nuevas van de la 58 en adelante. Lo que es deducción o estimación propia aparece marcado como tal.

Requisitos del propietario que fija esta versión:

1. El usuario no nota nada salvo que sus datos están más seguros: sin interruptor, sin ceremonia de clave de recuperación en el camino normal, sin etiqueta beta, misma velocidad, mismas funciones. Vale para quien solo usa la web (cualquier navegador, ventanas privadas, ordenadores compartidos) y para escritorio, Android e iOS.
2. Activado por defecto en todo: canales de espacio (miles de miembros), MD, grupos, hilos, chat de reunión, adjuntos, reacciones, ediciones, encuestas, programados, notas de voz, vistas previas (el servidor pide la URL, aprobado), Polar, automatizaciones, componentes, búsqueda, notificaciones y exportaciones.
3. Migración de todas las instancias existentes, sin pérdida, reanudable, idempotente, con copia y vuelta atrás, y correcta para quien no vuelve a entrar, cuentas borradas, bots y miembros que se fueron.
4. Nivel gubernamental, verificado con un proceso de aseguramiento interno (sin auditoría externa obligatoria).

---

## 0. Veredicto en una página

| Pregunta | Respuesta |
| --- | --- |
| ¿Se puede cumplir "el usuario no nota nada" con E2EE real? | Sí para quien entra con **contraseña o passkey**, y para cualquier dispositivo ya aprobado. Las claves se desbloquean con lo mismo que ya usa para entrar (sección 3). No hay pantalla nueva. |
| ¿Dónde no se puede, sin mentir? | Cuando el único factor del usuario lo controla el servidor (enlace mágico al correo, inicio con una conexión externa, restablecimiento hecho por un administrador). Ahí, quien recupera el historial sin ningún factor del usuario es, por definición, alguien distinto del usuario. La v2 lo resuelve con una **clave de recuperación de la organización con quórum** (M de N administradores, cada uso auditado y visible al usuario). Es la decisión 1 del propietario. |
| Protocolo | **MLS (RFC 9420)** para pertenencia autenticada, seguridad tras compromiso y claves de llamada [21][58]; **claves de historial por conversación** distribuidas por MLS y guardadas envueltas para cada cuenta, para que el historial se lea desde cualquier dispositivo nuevo (patrón Labyrinth [13][14]). Una copia cifrada por mensaje, sea cual sea el tamaño del grupo. |
| Migración | La hace el **servidor**, en un proceso aislado, conversación a conversación: cifra el historial que ya tenía en claro, envuelve la clave para cada miembro y para la recuperación de la organización, verifica con recuentos y hashes y solo entonces borra el texto en claro. Reanudable, idempotente, con instantánea de vuelta atrás cifrada (sección 8). |
| Lo que el servidor deja de ver | Texto, archivos, miniaturas, encuestas, ediciones, reacciones, borradores y notas de voz. |
| Lo que sigue viendo (metadatos) | Quién está en qué conversación (lo exige el modelo de permisos), cuándo y cuánto se envía, a quién se menciona, y las URL de las vistas previas que pide (aprobado). La sección 2 compara con Threema, que minimiza más; se copian sus técnicas donde no rompen funciones. |
| Coste visible que queda | (a) La primera búsqueda de historial antiguo en un navegador recién abierto tarda más que hoy si el historial es enorme (sección 6.1). (b) Los usuarios sin contraseña ni passkey que abren una ventana privada sin otro dispositivo propio dependen de la recuperación de la organización o de aprobar desde otro dispositivo (sección 3.5). (c) Las reglas automáticas sobre el **contenido** pasan al cliente. |
| Aseguramiento | Proceso interno: lista de fallos conocidos con fuentes, revisiones adversariales separadas por área con prueba que falla antes de cada arreglo, vectores RFC 9420, pruebas de propiedades, fuzzing de cada parser, interoperabilidad, migración sobre datos sintéticos grandes y caos. Puertas de lanzamiento explícitas (sección 11). Una auditoría externa queda como opción, no como requisito. |
| Tamaño | XXL. 14 fases (sección 13). Se activa para todos a la vez cuando pasan las puertas; no hay fase "opcional por conversación" visible para el usuario. |

---

## 1. Modelo de amenazas

### 1.1 Adversarios

| Adversario | Capacidades | ¿Protege la v2? |
| --- | --- | --- |
| Ladrón de disco, de una copia de la base de datos o de un backup | Lee todo lo almacenado, sin límite de tiempo | Sí. Lo almacenado es texto cifrado y claves envueltas. Los envoltorios por contraseña aguantan en proporción a la contraseña (Argon2id, 3.2). |
| Operador curioso o root robado, **pasivo** (lee la base de datos y la memoria del servidor) | Ve todo lo que pasa por el servidor | Sí para el contenido. No para los metadatos de 0. |
| Servidor **activo y malicioso** que manipula respuestas de la API | Inyecta dispositivos, reordena, reenvía, retiene commits, sirve claves falsas | Sí, si se cumplen 4.3 (credenciales firmadas por la cuenta, validación estricta de commits) y 4.6 (transparencia de claves). Es el adversario de los ataques a Matrix 2022 y a Threema 2023 [59][61]; la lista de 11.1 sale de ahí. |
| Servidor activo que **sirve JavaScript modificado** al cliente web | Puede robar claves de cualquier sesión web que cargue ese código | **No del todo, y esto vale para cualquier E2EE en web.** Mitigaciones en 4.7 (verificación del paquete por la extensión y el escritorio, modo "solo apps verificadas" para despliegues gubernamentales). Se declara. |
| Administrador de **otra** organización en la misma instancia | Acceso a su organización | Sí: sin claves de las conversaciones ajenas. |
| Quórum de administradores de **tu** organización | Puede reunir la clave de recuperación de la organización | No, si la organización la activa (decisión 1). Cada uso queda en el registro de auditoría encadenado y se notifica al afectado. |
| Dispositivo perdido o robado | Estado local | Se revoca desde cualquier otro dispositivo o por un administrador: Remove MLS y rotación de las claves de historial; opción de bloqueo remoto del almacenamiento local al estilo DualLock de Threema OnPrem [62]. |
| Adversario con ordenador cuántico futuro que guarda tráfico hoy | Descifra lo guardado cuando pueda | Se mitiga con envoltorios híbridos ML-KEM desde el principio (4.5, decisión 6). |

### 1.2 Lo que E2EE no resuelve aquí

- Metadatos de pertenencia: Polaris aplica permisos por canal, rol y espacio en el servidor. Threema no guarda en el servidor qué grupos existen ni quién está en ellos [62], pero Threema tampoco tiene canales de servidor con roles. Polaris se aparta aquí a propósito (sección 2.2).
- Un cliente modificado por su propio usuario puede saltarse cualquier regla aplicada en el cliente.
- Lo que un participante legítimo hace con lo que lee (capturas, reenvíos).

---

## 2. Referentes

### 2.1 Comparación

| Producto | Texto E2EE y grupos | Multidispositivo | Recuperación sin dispositivos | Organización / gobierno |
| --- | --- | --- | --- | --- |
| **Threema** (referente principal) | NaCl box por destinatario; los grupos se cifran **por separado para cada miembro** y el servidor no conoce los grupos [62]. Secreto hacia delante extremo a extremo con **Ibex** (2022-2023), con prueba formal independiente [63][64]. | Protocolo multidispositivo con **servidor mediador** entre el chat server y los dispositivos; clave de grupo de dispositivos (DGK) aleatoria que el mediador no conoce, transferida por QR con comparación de emojis; los mensajes enviados se "reflejan" a los demás dispositivos cifrados con una clave derivada de la DGK. **Sin PFS mientras el multidispositivo está activo** (lo dice el whitepaper) [62]. | **Threema Safe**: copia de la identidad, contactos y grupos (no mensajes) cifrada con una clave derivada de contraseña con scrypt (N=65536, r=8, p=1) y la ID como sal; el identificador del backup se deriva de la misma clave, así que el servidor no sabe de quién es cada backup; puede alojarse en un servidor propio [62]. | Work y OnPrem: consola central de usuarios y permisos, desactivar funciones, limitar a contactos internos, integración con Entra ID; uso anónimo sin teléfono ni correo [65]. **DualLock** (OnPrem): el almacenamiento local se cifra además con un secreto remoto que el administrador puede bloquear [62]. Administración federal suiza para información "confidencial" desde 2019, según Threema [66]. No se encontró un mecanismo para que la organización lea mensajes. Auditorías: Cure53 (apps 2020, escritorio 2024) y FH Münster (2019) [60]. |
| **WhatsApp** | Signal Protocol, Sender Keys en grupos [1][2] | Cada dispositivo tiene identidad propia firmada por el móvil [1][2] | Backup E2EE con clave en HSM (OPAQUE, límite de intentos) o clave de 64 dígitos [10][30]; desde octubre de 2025 también con **passkey** (huella, cara o bloqueo de pantalla) [67] | Cloud API: Meta guarda las claves de la empresa [8] |
| **Messenger** | Signal Protocol [12] | Historial en el servidor con Labyrinth [13][14] | PIN, cuenta de Apple o Google, código de 40 caracteres o código de un solo uso a un dispositivo reciente [68]; PIN protegido en HSM [30] | - |
| **Apple** | iMessage PQ3 [27] | iCloud Keychain | Depósito protegido por clústeres de HSM; el código se verifica con SRP sin enviarlo a Apple; tras 10 intentos fallidos el HSM destruye el registro [69]. Con **Advanced Data Protection** hay que configurar clave de recuperación o contacto de recuperación; sin ellos Apple no puede recuperar los datos [70] | - |
| **Google (Android)** | - | - | Backup cifrado con una clave protegida por el PIN o patrón de pantalla, guardada en chips Titan con límite de intentos (Cloud Key Vault) [71] | - |
| **Element / Matrix** | Olm + Megolm [31] | Dispositivos con cross-signing [36] | Clave de recuperación (SSSS) [35]; dispositivos "deshidratados" (MSC3814) para recibir claves sin dispositivo en línea [72]; Element X exige verificar el dispositivo al entrar [73] | **Tchap** (DINUM, Francia), cliente derivado de Element, servidores internos [74]; **BwMessenger** (Bundeswehr, BWI) [75]; **NI2CE** (OTAN), autoalojado [76]. No se encontró documentación pública de cómo resuelven la recuperación organizativa; no se afirma nada. |
| **Wire** | Proteus -> MLS [37] | Dispositivos por usuario | - | **Legal hold**: un dispositivo adicional ligado a la cuenta del usuario, gestionado por un servicio de la empresa, que entra en las conversaciones como cualquier dispositivo; indicador rojo en la conversación y junto al nombre; requiere consentimiento [77][78] |
| **Microsoft Teams** | E2EE solo en llamadas | - | - | Con E2EE no hay grabación de cumplimiento, eDiscovery, DLP, traducción ni transcripción [79] |

Lección: **nadie** que ofrece E2EE real mantiene una recuperación sin factor del usuario que no sea un tercero declarado (HSM del proveedor, contacto de recuperación, dispositivo de legal hold). Y quien quiere cumplimiento (Wire) lo hace con un **participante visible**, nunca con una lectura silenciosa del servidor.

### 2.2 Qué se copia de Threema y en qué se aparta Polaris

| Tema | Threema | Polaris v2 | Motivo |
| --- | --- | --- | --- |
| Push | El payload de APNs va cifrado con una clave simétrica que eligió el cliente; Apple no la conoce [62] | **Se copia**: el push lleva `{conversación, mensaje}` cifrado con una clave del dispositivo; el texto lo descifra el dispositivo | Apple, Google y el servicio de push no ven quién escribe a quién |
| Datos del dispositivo | Plataforma, versión y etiqueta se cifran con una clave del grupo de dispositivos; el mediador no los lee [62] | **Se copia** para la etiqueta y la lista de dispositivos de cifrado. La lista de **sesiones** de inicio (IP, navegador, `TrustedDevice`) sigue en el servidor porque es seguridad de cuenta | Minimizar sin perder la vista de sesiones |
| Descubrimiento de contactos | Hashes HMAC que el servidor descarta tras responder [62] | No aplica: Polaris no sube agendas | - |
| Recibos de entrega y lectura | Mensajes E2EE | `deliveredAt` / `readAt` por mensaje hoy están en `ChatMessage`. **Se copia en parte**: el servidor guarda solo el último leído por persona y conversación (lo necesita para los no leídos) y deja de guardar marcas por mensaje | Menos metadatos sin cambiar lo que se ve |
| Backup anónimo | El id del backup se deriva de la contraseña [62] | **Se copia** en el envoltorio por contraseña: el registro se localiza por un id derivado, no por el `userId` | Una copia robada no dice de quién es cada envoltorio sin la contraseña |
| Bloqueo remoto | DualLock [62] | **Se copia** como política de organización (apagada por defecto) | Encaja con dispositivos perdidos en gobierno |
| Vinculación de dispositivos | QR con clave de autenticación y comparación de emojis [62] | **Se copia** sobre el flujo de QR existente (`deviceAuthorization`, `DeviceCode`) | Ya existe el gesto; se añade el canal cifrado |
| Grupos | Cifrado por miembro; servidor sin pertenencia [62] | **Se aparta**: MLS, coste logarítmico, servidor con pertenencia | Canales de miles de miembros con roles y permisos |
| Multidispositivo | Sin PFS con multidispositivo [62] | **Se aparta**: MLS da seguridad tras compromiso con varios dispositivos; el historial recuperable sí implica que no hay secreto hacia delante por mensaje dentro de una época (4.2) | Mismo trade-off que Labyrinth; se declara |
| Backup de mensajes | Safe no guarda mensajes [62] | **Se aparta**: el historial completo está siempre en el servidor, cifrado | Requisito "cualquier navegador ve todo" |
| Protocolo de transporte propio | ETH recomendó TLS en lugar del protocolo cliente-servidor propio [61] | Polaris ya usa TLS | Lección aplicada |

---

## 3. Gestión de claves invisible

### 3.1 Jerarquía

| Clave | Qué es | Dónde vive | Se rota |
| --- | --- | --- | --- |
| **Clave de cuenta** (`AK`) | Par de firma (Ed25519) y par HPKE (X25519 + ML-KEM-768 híbrido) del usuario. Firma las credenciales de sus dispositivos y recibe envoltorios de claves de historial | Solo envuelta por "cierres" (3.2); en claro solo en memoria o en el almacén no exportable del dispositivo | Al revocar todos los dispositivos o por compromiso |
| **Clave de dispositivo** | Hoja MLS y clave de firma por dispositivo; credencial firmada por `AK` | WebCrypto no exportable en IndexedDB (web), almacén del sistema (Keychain, Keystore, DPAPI/safeStorage) | Updates MLS periódicos |
| **Clave de historial** (`HK(c, e)`) | 32 bytes aleatorios por conversación `c` y periodo `e`; cifra el contenido | Repartida dentro del grupo MLS y guardada envuelta para cada cuenta miembro y para la recuperación de la organización | Al quitar a alguien y cada cierto tiempo |
| **Clave de recuperación de la organización** (`ORK`) | Par HPKE; la privada se reparte con Shamir M de N entre dispositivos de administradores | Partes cifradas para cada custodio; nunca entera en el servidor | Al cambiar los custodios |
| **Clave de índice** | Cifra los segmentos del índice de búsqueda (6.1) | Derivada de `HK` por conversación | Con `HK` |

### 3.2 Cierres de la clave de cuenta (cómo se desbloquea sin ceremonia)

| Cierre | Qué hace | ¿Visible? | Fuerza | Precedente |
| --- | --- | --- | --- | --- |
| **Dispositivo** | `AK` envuelta con la clave no exportable del dispositivo | No | Alta mientras el dispositivo no esté comprometido | Todos |
| **Contraseña** | El cliente deriva de la contraseña dos valores con Argon2id: uno de autenticación (lo que se envía) y uno de envoltorio (que nunca sale). Hoy `better-auth` (`emailAndPassword`) recibe la contraseña y la comprueba en el servidor, así que **el servidor la ve**; con el cambio deja de verla. Se implementa con OPAQUE (RFC 9807), obligatorio: no revela la contraseña ni en el registro y resiste el precálculo tras un compromiso del servidor [80] | No: el usuario escribe lo mismo | Media: con la base de datos robada se pueden probar contraseñas sin límite (igual con OPAQUE tras el compromiso). Política de contraseñas ya existente + Argon2id con parámetros del orden de Threema Desktop (128 MiB) [62] | Modelo Bitwarden; Threema Safe [62] |
| **Passkey con PRF** | Al iniciar sesión con passkey se pide la extensión PRF de WebAuthn (W3C Recommendation, nivel 3, sección 10.1.4) [81]; su salida envuelve `AK` | No: es el mismo gesto de entrar | Alta (secreto del autenticador) | WhatsApp con passkeys [67] |
| **Aprobación desde otro dispositivo** | El flujo de QR existente transporta `AK` por un canal cifrado de extremo a extremo entre los dos dispositivos (patrón rendezvous de Threema [62]) | Es el gesto que ya existe para entrar por QR | Alta | WhatsApp [2], Threema [62] |
| **Recuperación de la organización** (`ORK`) | `AK` envuelta para `ORK`. Para usarla hace falta el quórum | Solo una línea en Seguridad: "Tu organización puede recuperar tu cuenta (N de M administradores)" | Alta frente al servidor; la organización por quórum sí puede | Contacto de recuperación de Apple [70]; legal hold de Wire en espíritu [77] |

Soporte de PRF: Chromium lo envió (intención de lanzamiento en blink-dev) [82]; hay informes de que el flujo entre dispositivos de Safari no devolvía PRF [83] y de fallos en Firefox para macOS [84]. **No se puede depender solo de PRF**: es un cierre más cuando el autenticador lo da, y su ausencia no cambia nada para el usuario.

**Objetivo del propietario (2026-11-21): un hackeo del servidor nunca entrega mensajes.** Lo que eso fija en esta sección:

| Lo que roba o controla el atacante | Qué obtiene | Qué lo cierra |
| --- | --- | --- |
| La base de datos, el disco, el NAS o las copias de seguridad | Texto cifrado, envoltorios y metadatos mínimos; ningún mensaje | El servidor nunca tiene `AK` ni `HK` en claro. Las partes del quórum (`ORK`) están envueltas para los **dispositivos** de los custodios, no guardadas en claro en el servidor |
| Lo anterior + fuerza bruta contra el envoltorio por contraseña | Solo las cuentas con contraseñas débiles | **OPAQUE (RFC 9807) obligatorio para toda cuenta con contraseña, sin ajuste para desactivarlo** (decisión del propietario, 2026-11-21), no una derivación simple. Las cuentas existentes siguen entrando igual y pasan a OPAQUE en su siguiente inicio de sesión, sin pasos visibles; ninguna cuenta queda bloqueada por la transición: el servidor no ve la contraseña ni en el registro y no puede precalcular. Argon2id con parámetros altos (128 MiB) y la política de contraseñas existente (Have I Been Pwned). Ajuste de organización e instancia **"sin cierre por contraseña"** (apagado por defecto): la contraseña solo autentica y `AK` exige dispositivo, passkey PRF o quórum |
| El servidor en marcha, modificado | Podría servir JavaScript alterado o añadir un dispositivo falso | Modo "solo apps verificadas" (decisión 8), transparencia de claves (4.6) y aviso en todos los dispositivos de la cuenta cuando se añade uno nuevo o se desbloquea `AK` solo con contraseña |
| La cuenta de un administrador | Nada por sí sola | La recuperación exige el quórum y cada uso se registra y se notifica al afectado. Con un solo administrador en la instancia, el riesgo es ese administrador: la pantalla de seguridad lo dice y recomienda un segundo custodio |
| El propio dispositivo del usuario (malware, sistema comprometido) | Lo que ese dispositivo ve | Fuera del modelo, como en Signal, WhatsApp o Threema. La baja de inactivos (decisión 7) y el borrado remoto limitan el daño |

### 3.3 Recorridos por tipo de usuario

| Situación | Qué pasa | ¿Nota algo? |
| --- | --- | --- |
| Contraseña, cualquier navegador, ventana privada u ordenador compartido | Al entrar, el cliente deriva la clave de envoltorio y abre `AK` en memoria. En ventana privada no se escribe nada persistente; al cerrar se pierde y se vuelve a derivar al entrar | No |
| Passkey con PRF | Igual, con la salida PRF | No |
| Passkey sin PRF (autenticador o navegador sin soporte) | Si ya hay un cierre de dispositivo: nada. Si es un navegador nuevo: aprobación desde otro dispositivo propio (el QR que ya existe) o recuperación de la organización automática si la organización la configuró como "sin intervención" (decisión 1) | Solo en navegador nuevo, y solo si no tiene contraseña |
| Enlace mágico o conexión externa (sin contraseña ni passkey) | Igual que la fila anterior | Igual que la fila anterior |
| 2FA (TOTP, código por SMS) | No es un cierre: un segundo factor que el servidor verifica no protege frente al servidor. Sigue igual como control de acceso | No |
| Restablece la contraseña (olvidada) | El envoltorio por contraseña ya no abre. Se recupera `AK` con: cualquier dispositivo propio aprobado, passkey PRF, o recuperación de la organización. Tras recuperar, se crea el envoltorio con la contraseña nueva | No, si tiene otro dispositivo, passkey PRF o la organización la tiene activada |
| Recuperación de cuenta por administrador (`account-recovery-service`, flujo actual) | Hoy el administrador aprueba y deja pasar una contraseña nueva. Con E2EE, aprobar sin `ORK` devuelve la cuenta **sin el historial**; con `ORK`, la misma aprobación dispara la petición de quórum. El afectado y todos los custodios lo ven en el registro | El administrador ve un paso más; el usuario, no |
| Varias cuentas en el mismo navegador | Un almacén de claves por `userId`, cada uno envuelto por su propio cierre de dispositivo; cambiar de cuenta no mezcla claves ni índices | No |
| Cerrar sesión | Se borran el almacén de claves, el índice y la caché de mensajes de esa cuenta en ese navegador; las demás cuentas no se tocan. En un dispositivo marcado como de confianza se puede conservar (como hoy con `TrustedDevice`) | No |
| Usuario nuevo | `AK` se genera en el primer inicio de sesión tras la actualización; los cierres se crean con lo que use para entrar | No |
| Usuario que no vuelve a entrar nunca | No tiene `AK`. Su historial queda envuelto para `ORK` y para los demás miembros (8.4); si vuelve, recibe las claves al entrar | No |
| Cuenta borrada | Se borran sus cierres. Sus mensajes en conversaciones compartidas siguen legibles para los demás (claves de historial de la conversación, no suyas) | No |
| Bots, Polar, webhooks | Miembros de servicio con `AK` propia guardada por el servidor (sección 7) | No |
| API keys | Una API key autentica, no descifra. Un cliente por API que deba leer el chat es un miembro de servicio o un dispositivo del usuario con su propia credencial firmada | Cambia para integraciones que leían `body` por la API; se declara en la nota de la versión |

### 3.4 Dónde está la línea honesta

Para un usuario que **solo** tiene factores controlados por el servidor (enlace mágico, conexión externa, restablecimiento por administrador), las tres cosas siguientes no caben juntas: (1) cero pasos visibles en un navegador nuevo, (2) historial completo, (3) que nadie más que él pueda leerlo. La v2 ofrece elegir cuál se cede (decisión 1):

| Modo | Quién puede recuperar sin factor del usuario | Usuario sin factor propio en navegador nuevo |
| --- | --- | --- |
| **A. Recuperación de la organización con quórum** (recomendado) | M de N custodios de la organización, auditado y notificado | Recuperación automática si la organización activa "sin intervención" (los custodios pre-autorizan con un umbral de tiempo; ver 3.5), si no, un aviso "Pide acceso a tu organización" |
| **B. Solo factores del usuario** (máximo para inteligencia) | Nadie | Debe aprobar desde otro dispositivo propio; sin él, el historial anterior no se recupera |
| **C. Custodia del servidor** | El servidor | Nada visible, pero **no es E2EE frente al servidor** para esos usuarios; la pantalla de Seguridad lo dice |

### 3.5 Recuperación de la organización sin intervención humana en cada uso

Pedir el quórum cada vez que alguien abre una ventana privada no es invisible. Diseño propio (a revisar en 11.2): los custodios firman, con el quórum, una **delegación por política** a un servicio de recuperación que corre en el servidor, con límites: solo para cuentas de la organización, solo tras un inicio de sesión completo (con 2FA si la cuenta lo tiene), solo si la cuenta no tiene ningún factor propio, como máximo K recuperaciones por cuenta y día, y cada uso notificado al usuario y anotado en el registro encadenado. **Esto equivale a custodia del servidor para esos usuarios mientras la delegación esté activa**, y la pantalla de Seguridad del administrador lo dice con esas palabras. Sin delegación, la recuperación espera al quórum.

---

## 4. Protocolo

### 4.1 Por qué MLS (resumen de la v1)

Coste logarítmico por cambio de miembros frente al cuadrático de Sender Keys, seguridad tras compromiso nativa, de dos a miles de miembros, la misma sesión deriva claves de llamada, estándar IETF con arquitectura en RFC 9750 (Servicio de Entrega y Servicio de Autenticación como papeles separados) [21][58]. Threema cifra por miembro y le basta porque sus grupos son pequeños y el servidor no conoce los grupos [62]; Polaris tiene canales de miles.

### 4.2 Diseño

1. **Un grupo MLS por conversación** (MD, grupo, canal, hilo hereda el de su canal, chat de reunión). Hojas = dispositivos. El servidor es el Servicio de Entrega y ordena los commits por época.
2. **Credenciales firmadas por la clave de cuenta**, nunca por el servidor. El Servicio de Autenticación de RFC 9750 [58] es el propio usuario (su `AK`) más la transparencia de claves (4.6).
3. **Contenido**: `K_msg = HKDF(HK(c,e), "polaris/msg" || message_id || sender_leaf)`, AES-256-GCM con nonce derivado, firma del dispositivo emisor sobre `(conversación, message_id, epoch, hash del texto cifrado)`. Una sola copia cifrada por mensaje.
4. **Reparto de `HK`**: quien hace el commit genera `HK` nueva y la manda como mensaje de aplicación MLS. Cada dispositivo que la recibe escribe, si falta, el envoltorio para su propia `AK` (uno por usuario, autoservicio, como Labyrinth 1.1 [14]). El que hace el commit escribe además el envoltorio para `ORK` y para los **miembros durmientes** (sin dispositivo activo en el grupo).
5. **Hilos**: comparten el grupo del canal. **Ediciones, reacciones, votos, borrados**: mensajes cifrados que apuntan a un `message_id`.
6. **Coste declarado**: dentro de un periodo `e` no hay secreto hacia delante por mensaje, porque el historial tiene que poder leerse desde un dispositivo nuevo. Es la concesión de Labyrinth y de cualquier historial recuperable [13]. Threema la evita no guardando historial en el servidor [62].
7. **Esta capa (3 y 4) es criptografía propia** sobre primitivas estándar. Por eso tiene revisor adversarial propio (11.2) y vectores de prueba propios (11.3).

### 4.3 Validaciones que el cliente hace siempre (contra el servidor malicioso)

| Comprobación | Ataque que evita | Fuente |
| --- | --- | --- |
| Toda hoja nueva lleva credencial firmada por la `AK` del usuario, y esa `AK` coincide con la vista en el registro de transparencia | Servidor que añade un dispositivo propio | Matrix 2022: el servidor podía añadir dispositivos y confundir identificadores [59] |
| Pertenencia del grupo MLS = pertenencia autorizada que el servidor declara, y cualquier diferencia se muestra | Servidor que mete a alguien sin que el grupo lo sepa | Crítica a la gestión de grupos de WhatsApp, Signal y Threema [85] |
| Commits y Welcome validados completos según RFC 9420 (árbol, firmas, transcript hash, `confirmation_tag`), incluidos los external commits | Commits malformados o divergentes | RFC 9420 [21] |
| Cada mensaje cifrado se liga a `(conversación, epoch, message_id, emisor)` en los datos asociados; contador por emisor y detección de huecos | Reordenar, borrar, reenviar, reflejar mensajes | Threema 2023: reordenación y borrado, repetición y reflexión [61] |
| Separación de claves por propósito con etiquetas distintas en cada derivación | Interacciones entre protocolos | Lección 2 de ETH sobre Threema [61]; confusión Olm/Megolm en Matrix (CVE-2022-39251) [59] |
| Estado MLS con versión monótona; rechazar estado anterior | Vuelta atrás del estado local | - |
| Nunca degradar a texto en claro ni a un ciphersuite más débil sin una nueva versión del protocolo firmada | Downgrade | Telegram: ataques al protocolo y al intercambio de claves del servidor [86] |

### 4.4 Ciphersuite

`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` al principio; suite híbrido con ML-KEM cuando la biblioteca implemente el borrador del grupo de trabajo, que define ML-KEM-768 + X25519 entre otros y advierte que con firma clásica la autenticidad sigue siendo solo clásica [87].

### 4.5 Poscuántico en lo almacenado

Lo que queda guardado años (envoltorios de `HK` para cuentas y para `ORK`) usa HPKE híbrido X25519 + ML-KEM-768 desde el primer día: es justo lo que un adversario guarda ahora para descifrar después. Coste: unos 1.100 bytes por envoltorio (tamaño de texto cifrado de ML-KEM-768, deducción a confirmar con la biblioteca elegida). Decisión 6.

### 4.6 Transparencia de claves

Registro de solo añadir de `AK` por usuario, verificable por los clientes (patrón de WhatsApp [57]). Sin él, el servidor puede dar una `AK` falsa a un usuario concreto. Se adelanta respecto a la v1 porque "sin verificación manual" (requisito 1) solo es seguro si el cliente comprueba solo.

**Verificación manual opcional y avisos de cambio de clave** (paridad con WhatsApp, fila 34 del registro de `chat-roadmap.md` sección 6). La transparencia sigue siendo lo que protege por defecto y nadie tiene que hacer nada; esto se añade para quien no quiere confiar solo en ella:

- **Código de seguridad por pareja.** Cada conversación directa muestra, en "Cifrado" de su panel de detalles, un número de 60 cifras (12 grupos de 5) y un QR, derivados de las dos `AK` (huella de cada una, ordenadas por id de cuenta, como el código de seguridad de Signal y WhatsApp). Comparado en persona o escaneado con la otra persona, la pareja queda marcada como **verificada** en los dispositivos de los dos; la marca es local y cifrada con la clave de cuenta, el servidor no sabe quién verificó a quién.
- **Aviso de cambio de clave.** Cuando la `AK` de un miembro cambia (dispositivo nuevo que rehace la cuenta, recuperación de 3.5), cada cliente añade en la conversación una línea local "La clave de seguridad de X ha cambiado" con enlace al código nuevo. Una pareja verificada pierde la marca y el aviso es más visible; no bloquea el envío salvo que la organización lo pida. Un dispositivo nuevo que no cambia la `AK` (se une con 3.2) no genera aviso, solo la línea de dispositivos de la sección 9.
- **Grupos.** Un aviso por miembro cuya clave cambia; la verificación sigue siendo por pareja.
- **Política.** La organización puede forzar los avisos de cambio de clave (no se pueden ocultar) y, para perfiles de alto riesgo, exigir verificación manual antes del primer mensaje a un contacto de fuera de la organización. Por defecto: avisos visibles, verificación opcional.
- **Coherencia con la transparencia.** Un cambio de clave que el registro de 4.6 no confirma es un fallo de verificación, no un aviso: el cliente no cifra hacia esa clave y lo dice.

### 4.7 Confianza en el código web

En la web, el servidor entrega el código que guarda las claves. Medidas:

| Medida | Efecto |
| --- | --- |
| Paquete de cifrado separado, con hash publicado en el registro de transparencia de cada versión | Un cambio silencioso para una sola persona queda a la vista |
| La extensión de Polaris y la app de escritorio verifican ese hash antes de cargar las claves | Quien usa una de las dos está protegido frente a JS modificado |
| Política de organización "solo apps verificadas" (apagada por defecto) | Despliegues de inteligencia: el navegador sin extensión no abre conversaciones cifradas |
| CSP estricta, sin `eval`, Trusted Types en el renderizado de mensajes | El XSS en el render es la vía clásica: Signal Desktop CVE-2018-10994 permitía inyectar HTML por un mensaje [88]; Wire tuvo un framework JS antiguo explotable [89] |

---

## 5. Mapa de funciones (cambios respecto a la v1)

Se mantiene el mapa de la v1 (secciones 4.1-4.9) con estos cambios, que salen de los requisitos nuevos:

| Función | v1 | v2 |
| --- | --- | --- |
| Activación | Opción por conversación | Siempre, para todo, sin interruptor |
| Vistas previas de enlaces | Emisor nativo directo; web vía servidor declarado | **Siempre vía servidor** (aprobado, como Discord): el cliente pide la tarjeta a `link-preview.ts` por `safe-fetch`, el servidor ve la URL y quién la pide, **no** en qué conversación se pega; la tarjeta y la miniatura viajan cifradas dentro del mensaje. Lo ven los lectores sin pedir nada |
| Búsqueda | Índice local; dispositivo nuevo indexa | Índice en segmentos cifrados compartidos (6.1) |
| Polar y bots | Desactivados en conversaciones cifradas hasta la fase 7 | Funcionan desde el primer día (sección 7) |
| Migración | Línea en el historial y recifrado opcional | Todo el historial se convierte y se borra el texto en claro (sección 8) |
| Recuperación | Clave de recuperación siempre | Sin ceremonia (sección 3) |
| Recibos por mensaje | Metadato | Se reduce a "último leído" (2.2) |
| Clientes antiguos | Pantalla de "actualiza" | Corte por conversación cuando todos los dispositivos activos lo soportan, con plazo (8.6) |
| Auditoría externa | Requisito antes de activar | Proceso interno; externa opcional (sección 11) |

---

## 6. Funciones que hoy leen texto en el servidor

Lectores de `ChatMessage.body` en el servidor hoy: `lib/chat/search.ts` (`body contains`, insensible a mayúsculas), `notify.ts` y `toasts.ts` (texto de avisos), `references.ts`, `polls.ts`, `reports.ts`, `notices.ts`, `link-preview.ts`, `chat-service.ts`, `messages.ts`, y fuera del chat `lib/home/alerts.ts`. Cada uno tiene destino:

| Función | Cómo se mueve | ¿Nota algo el usuario? |
| --- | --- | --- |
| Búsqueda | 6.1 | Ver 6.1 |
| No leídos, menciones, niveles de aviso (`notify.ts`, `room-mentions.ts`) | El emisor adjunta en claro la lista de ids mencionados y si es @sala; el servidor sigue aplicando niveles y silencios; recuento de no leídos por "último leído" | No |
| Texto de las notificaciones | Push con el texto cifrado (si cabe) o con el id; lo descifra el Service Worker, la app de escritorio, la Notification Service Extension en iOS [52] o el manejador de datos en Android [53]; payload cifrado también frente al servicio de push (patrón Threema [62]) | No. Si el estado no está disponible, "Mensaje nuevo de Nombre" |
| Avisos en Inicio (`home/alerts.ts`) | Solo metadatos del servidor; el extracto lo descifra el cliente al pintar | No |
| Polar | Sección 7 | No |
| Moderación y reglas de contenido | Las reglas de `@polaris/core` que dependen de metadatos (lentitud, tamaño, número de adjuntos, permisos) siguen en el servidor. Las que miran el **contenido** se aplican en el cliente emisor con la misma función pura de `core` y se comprueban en el receptor (que oculta lo que las incumple). Denuncias con franking [47][49] | No para quien usa el cliente oficial; un cliente modificado puede saltarse las de contenido (declarado) |
| Firewall de la plataforma | Es de red y de peticiones, no de contenido de chat: sin cambios | No |
| Vistas previas | Servidor pide la URL (aprobado), la tarjeta viaja cifrada | No |
| Miniaturas y posters | Las genera el emisor (el cliente ya graba clips y ya conoce el archivo) y se suben cifradas | No |
| Transcripción de notas de voz | En el dispositivo cuando hay motor local; si no, Polar como participante con el consentimiento implícito de pulsar "Transcribir" | No |
| Traducción | En el dispositivo cuando el navegador o el sistema lo permiten; si no, vía Polar | No |
| Referencias a tareas | Las resuelve el cliente contra la API de Tasks con sus permisos | No |
| Encuestas | Votos cifrados; recuento en el cliente | No |
| Programados | El cliente cifra al programar; si el periodo cambia antes de publicar, un dispositivo del autor lo vuelve a cifrar; si ninguno está en línea, el servidor publica el cifrado con la `HK` anterior y los miembros vigentes la tienen (v1 4.1) | No |
| Exportación del usuario | En el cliente, descifrando | No |
| Exportación e importación de Polaris completo | Lleva texto cifrado, envoltorios de `AK` y de `HK`; tras importar, los cierres siguen funcionando porque viajan con los datos | No |
| Exportación de cumplimiento | Sección 9 | - |

### 6.1 Búsqueda instantánea en un navegador recién abierto

Problema: hoy `search.ts` consulta PostgreSQL. Con E2EE el servidor no puede. Un índice local frío en una ventana privada tarda en proporción al historial.

Diseño: **segmentos de índice cifrados y compartidos por conversación**.

| Pieza | Cómo |
| --- | --- |
| Segmento | Índice invertido comprimido de un tramo de mensajes de una conversación (por ejemplo, 5.000 mensajes o un periodo `e`), cifrado con la clave de índice derivada de `HK` |
| Quién lo construye | El primer dispositivo miembro que tiene el tramo descifrado, en segundo plano; para el historial migrado, el propio proceso de migración (ya tenía el texto) |
| Reutilización | Un segmento sirve a todos los miembros: no se construye por persona |
| Navegador nuevo | Descarga los segmentos de las conversaciones a las que tiene acceso, recientes primero, en paralelo, los descifra en un Worker y busca en memoria (o en IndexedDB si la sesión no es privada) |
| Ediciones y borrados | Segmento de corrección pequeño; se compacta periódicamente |
| Fuga | El servidor ve tamaño y número de segmentos por conversación; no ve términos. Descartado el cifrado buscable con tokens deterministas porque filtra frecuencias y patrones de acceso (v1 4.4) |

Velocidad (estimación a medir en fase 0): un segmento de 5.000 mensajes de unos 150 bytes son unos 750 KB de texto; un índice comprimido suele ocupar una fracción de eso. Los últimos 90 días de un usuario normal caben en pocos MB y se buscan en menos de un segundo tras descargarlos. Para un usuario en cientos de canales con millones de mensajes, la búsqueda de lo antiguo **no** es instantánea en una ventana privada: se muestra lo reciente al momento y lo antiguo según llega, con "buscando más atrás". Es el coste visible (a) de la sección 0 y se declara.

---

## 7. Polar, automatizaciones, bots y componentes

Principio de la v1 sin cambios: lo que corre en el servidor y lee contenido es un **participante con claves**, visible en la lista de miembros.

| Función | v2 |
| --- | --- |
| Polar por mención (`@Polar`, `/polar`) | El cliente del invocador envía a Polar el mensaje y el contexto, cifrados para la `AK` de servicio de Polar. Polar responde cifrando para el grupo como miembro de servicio. Igual que hoy para el usuario |
| Polar con acceso a toda la conversación (resúmenes, proactivo) | Polar como hoja MLS, visible con "Puede leer los mensajes"; se añade o quita como cualquier miembro |
| Webhooks y automatizaciones | Miembro de servicio cuyas claves guarda el servidor; el contenido nace en el servidor (modelo Cloud API de WhatsApp [8]) |
| Componentes y comandos de app | Definición dentro del mensaje cifrado; la interacción va cifrada al miembro de servicio dueño; `/task` lo ejecuta el cliente contra Tasks |
| Avisos del sistema (entradas, salidas, llamadas perdidas) | Eventos tipados que el servidor ya conoce como metadatos; se pintan igual |
| Honestidad | Lo que se manda a Polar lo lee quien ejecuta Polar (el operador) y el proveedor del modelo. La lista de miembros lo muestra; no hay lectura silenciosa |

---

## 8. Migración de todas las instancias

### 8.1 Quién cifra el historial y qué confianza implica

Lo cifra el **servidor**, porque los clientes pueden no volver nunca y son millones de mensajes. El servidor ya tenía ese texto en claro, así que la migración **no añade** exposición: reduce la futura. Lo que no puede hacer es borrar el pasado: copias de seguridad, WAL archivado, réplicas y cualquier copia anterior conservan el texto hasta que se purgan (8.5).

Minimización de la confianza en el proceso:

| Medida | Efecto |
| --- | --- |
| Proceso aislado (`chat-migrator`) con su propia conexión, sin red de salida, sin registro de contenido | Superficie mínima |
| `HK(c, legacy)` generada dentro del proceso, envuelta al momento para cada miembro con `AK`, para `ORK` y nada más, y borrada de memoria al terminar la conversación | El servidor no conserva ninguna clave que abra el historial migrado |
| El historial migrado se firma con una clave de migración de un solo uso cuyo público se publica en el registro de transparencia; los clientes lo muestran como "historial anterior a [fecha]" con la misma apariencia | Honesto sobre el origen sin ruido visual |
| Registro en la auditoría (`chat.migration.*`) de cada lote con recuentos y hashes | Evidencia para SOC 2/ISO, en línea con `docs/compliance.md` |

### 8.2 Fases de la migración en una instancia

| Fase | Qué hace | Reversible |
| --- | --- | --- |
| M0 Preparación | Migraciones de esquema **aditivas**: columnas `ciphertext`, `cipherMeta`, `keyEpoch` en mensajes, adjuntos, ediciones, programados, encuestas; tablas de claves envueltas, segmentos de índice y estado de migración por conversación. Nada se borra | Sí |
| M1 Escritura doble | Los clientes nuevos envían cifrado. Para conversaciones aún no cortadas, el servidor guarda además el texto en claro **solo** si algún dispositivo activo de un miembro es antiguo (8.6) | Sí |
| M2 Conversión por conversación | El migrador toma conversaciones por lotes, cifra mensajes, ediciones, encuestas, adjuntos (archivo a archivo, en bloques de 64 KiB) y miniaturas; construye segmentos de índice; escribe envoltorios | Sí: el texto en claro sigue |
| M3 Verificación | Por conversación: recuento de filas en claro = recuento cifrado; para cada mensaje, `SHA-256(texto en claro)` comparado con el hash dentro del cifrado tras descifrar una muestra **completa** con la `HK` antes de borrarla de memoria; para adjuntos, tamaño y SHA-256 por archivo. Cualquier diferencia deja la conversación en "pendiente" y no avanza | Sí |
| M4 Corte | La conversación pasa a "solo cifrado": la API deja de servir texto en claro de ella | Sí: volver a M3 |
| M5 Borrado | Tras un periodo de gracia configurable sin incidencias: se vacían las columnas en claro y los archivos sin cifrar se eliminan del almacén (local, NAS, S3); `VACUUM` y reescritura de las tablas afectadas para que el texto no quede en páginas muertas | No, salvo con la instantánea de 8.5 |
| M6 Retirada | En una versión posterior, el código y las columnas en claro se eliminan **solo si** el estado de migración dice "todo cortado y borrado"; nunca por número de versión | No |

### 8.3 Reanudable, idempotente y escalable

- Estado por conversación en una tabla (`pending`, `converting`, `verifying`, `cut`, `purged`, `failed`) con cursor por `(channelId, createdAt, id)`, que es el índice que ya existe en `ChatMessage`.
- Cada lote es una transacción: escribe cifrado solo donde `ciphertext IS NULL`. Repetir un lote no cambia nada. Un corte de luz deja como mucho un lote a medias que se repite.
- Ritmo limitado por carga (CPU y latencia de la base de datos), pausa automática si la instancia está ocupada, con progreso visible en Administración ("Protegiendo el historial del chat: 63%").
- Rendimiento (estimación a medir en fase 0): AES-GCM con aceleración por hardware cifra a cientos de MB/s; el límite es la base de datos. Con lotes de unos miles de filas y un proceso, el orden de magnitud esperable es de miles de mensajes por segundo, es decir, 10 millones de mensajes en horas, no en días. Los adjuntos dependen del almacén (NAS o S3) y van en una cola aparte.
- Instancias que se saltan versiones: la migración arranca en la primera versión que la contiene, sea cual sea la anterior, y los pasos destructivos (M5, M6) comprueban el estado, no la versión.
- Funciona en la edición limitada (sin hostd) porque corre dentro del panel y no necesita variables nuevas en `.env`.

### 8.4 Casos especiales

| Caso | Tratamiento |
| --- | --- |
| Miembro que nunca vuelve a entrar | Sin `AK`: no recibe envoltorio. Su historial queda envuelto para `ORK` y para los demás miembros. Si vuelve, al crear su `AK` cualquier dispositivo miembro en línea le escribe los envoltorios en segundo plano (patrón de historial compartido de Element [34]); si no hay ninguno, la recuperación de la organización lo hace |
| Conversación sin ningún miembro con `AK` (por ejemplo, un MD entre dos personas que no vuelven) | Solo envoltorio para `ORK`. **Sin `ORK` (modo B de 3.4) esa conversación no tiene a quién envolverse**: o se deja sin migrar (texto en claro) hasta que un miembro entre, o se envuelve con una clave de custodia del servidor marcada como tal. Decisión 1 |
| Cuenta borrada | Sus mensajes se migran como los demás (son de la conversación); no recibe envoltorio |
| Miembro que se fue | Recibe envoltorio solo para el tramo que ve hoy según la política actual de historial; nada posterior |
| Bots y webhooks | Su `AK` de servicio se crea en M0; sus mensajes se migran igual |
| Mensajes programados pendientes | Se cifran con la `HK` vigente al publicar |
| Denuncias abiertas (`ChatReport`) | El contenido denunciado se conserva en el expediente de moderación como evidencia firmada por la migración, porque el denunciante ya lo compartió; queda en la retención de moderación |
| Chat de reunión con invitados sin cuenta | Su historial se envuelve para los miembros con cuenta y `ORK` |

### 8.5 Copias, vuelta atrás y purga del pasado

| Pieza | Diseño |
| --- | --- |
| Antes de M2 | Backup completo con la función de Backups existente, comprobado (restaurable) antes de empezar; si no hay destino de backup configurado, la migración no empieza y Administración lo dice con el botón para configurarlo |
| Instantánea de vuelta atrás | Copia de las tablas y archivos en claro, cifrada para `ORK` (o para una clave de vuelta atrás offline si no hay `ORK`), guardada N días |
| Vuelta atrás | Por conversación (M4 -> M3) o global mientras exista la instantánea; probada en la suite de migración |
| Purga | Al vencer N días, se destruye la instantánea. Los backups anteriores a la migración siguen conteniendo texto en claro hasta que su retención los elimina; Administración ofrece "Eliminar ahora las copias anteriores con chat en claro" (decisión 4). Sin esto, la frase "el texto en claro se ha eliminado" sería falsa |

### 8.6 Desfase de versiones de los clientes

La web siempre llega actualizada (la sirve la propia instancia). El desfase está en escritorio, extensión, Android e iOS, que hablan con instancias de muchas versiones distintas.

| Regla | Detalle |
| --- | --- |
| Capacidad anunciada por dispositivo | Cada cliente declara `e2ee: vN` al conectar |
| Corte por conversación | Una conversación pasa a M4 cuando todos los dispositivos **activos** (vistos en los últimos N días) de sus miembros soportan E2EE, o al vencer el plazo de transición |
| Durante la transición | Los clientes antiguos siguen leyendo y escribiendo en claro en las conversaciones no cortadas (lo que hoy ya pasa) |
| Después | El cliente antiguo ve "Actualiza para seguir en esta conversación" con el botón de actualizar. Escritorio y móvil se actualizan solos, así que es raro |
| Cliente nuevo contra instancia antigua | El cliente detecta que la instancia no anuncia E2EE y funciona como hoy, sin mostrar nada |
| Nunca | Descifrar en el servidor para un cliente antiguo |

---

## 9. Controles de organización (gobierno y empresa)

| Necesidad | Opción sin romper E2EE | Recomendación |
| --- | --- | --- |
| Retención | El servidor borra el texto cifrado y los envoltorios por antigüedad (no necesita claves); los clientes borran su copia local con la misma política | Igual que hoy, sin cambio visible |
| Retención legal (legal hold) | Suspender el borrado para un sujeto o una conversación; no necesita claves | Disponible siempre |
| Exportación de cumplimiento o eDiscovery | **Opción 1**: `ORK` por quórum descifra lo pedido; cada uso queda en el registro encadenado (`evidence.export` ya registra exportaciones con hash) y se notifica a los afectados. **Opción 2**: miembro "Archivo de la organización" visible en las conversaciones del sujeto, con indicador (modelo legal hold de Wire [77][78]). **Opción 3**: ninguna (modelo Threema Work, Teams E2EE [79]) | Opción 1 disponible si existe `ORK`; Opción 2 apagada por defecto, para regulados; la pantalla de cada conversación dice la verdad |
| Auditoría | Los eventos de claves (dispositivo añadido, recuperación usada, custodios cambiados, migración) entran en el registro de auditoría encadenado que ya existe | Siempre |
| Dispositivo perdido o persona que se va | Revocar dispositivos (Remove MLS + rotación de `HK`) y, opcional, DualLock [62] | Revocación siempre; DualLock como política |
| Evidencia SOC 2 / ISO | La evidencia de `docs/compliance.md` añade: estado de migración, porcentaje cifrado, custodios de `ORK`, usos de recuperación | Siempre |

---

## 10. Rendimiento

| Dimensión | Diseño | Coste |
| --- | --- | --- |
| Primer pintado | Sin cambios: el armazón y lo que el dispositivo ya tenía (la rama del almacén offline ya abre conversaciones desde lo guardado antes de que conteste la red) se pintan antes de cargar nada criptográfico | Ninguno |
| Biblioteca MLS (WASM) | **OpenMLS 0.9.2**, elegida en la fase 0: única candidata con auditoría externa publicada, Rust con memoria segura, mismo núcleo nativo en Android e iOS [P0]. Carga diferida en un Worker al abrir el chat o en reposo tras el primer pintado, con nombre con hash, `immutable` y precarga en el Service Worker; el descifrado de mensajes con `HK` usa WebCrypto y no necesita el WASM, así que leer no espera a MLS | 371 KB con brotli; `init()` 16 ms en Chromium y 70 ms con CPU x4 más lenta [P0] |
| Descifrado de una conversación | Por lotes, solo la ventana visible, en el Worker | Despreciable por mensaje |
| Envío | Un AES-GCM y una firma por mensaje | Despreciable |
| Canal de 10.000 miembros con 3 dispositivos | En teoría `log2(N)` cifrados de ruta por commit [21]. **La fase 0 midió otra cosa** con un árbol recién creado por altas masivas: los nodos intermedios quedan vacíos y un commit de alta o baja crece **lineal**, unos 82 B por miembro (~410 KB a 5.000) [P0]. Por eso los miembros entran al grupo MLS del canal **al abrirlo por primera vez** (external commit), no al unirse al espacio ni en bloque al migrar; cada dispositivo emite un commit de actualización propio al entrar (rellena su ruta); altas y bajas se agrupan en commits periódicos; el servidor propone bajas como remitente externo. El estado estacionario con el árbol lleno está **sin medir** y es lo primero de la fase 4 | Estado por dispositivo ~1 MB a 1.000 miembros y ~5 MB a 5.000 [P0]; crear o migrar un grupo de 5.000 cuesta ~8 s, siempre en un Worker y por tandas [P0] |
| Dispositivos inactivos | Bajas automáticas tras N días sin conexión (protege la seguridad tras compromiso y reduce el árbol); al volver entran con external commit | Decisión 7 |
| Mensaje en canal grande | Una escritura y un reparto; nada por destinatario | Igual que hoy |
| Almacenamiento | Archivos sin duplicar (10b); unos 92 B por mensaje (v1) + segmentos de índice + envoltorios (32 B + cabecera por clave, unos 1.100 B con ML-KEM) por periodo y miembro | Moderado; los periodos rotan poco |
| CPU del servidor | Deja de indexar texto y generar miniaturas; valida commits | Menor que hoy (deducción) |

## 10b. Almacenamiento: deduplicación y destinos sin fugas

### 10b.1 Lo que existe hoy (auditado en el código)

| Pieza | Comportamiento actual | Evidencia |
| --- | --- | --- |
| Destino de los archivos del chat | Ajuste `CHAT_TARGET_KEY`: una conexión (NAS u otra), `local` o `auto` (NAS si la instancia tiene, si no este servidor) | `dashboard/apps/web/src/lib/chat/attachments.ts:149-166` (`chatStorageSettings`, `chatTarget` -> `resolveStorageTarget`) |
| Escritura | Un archivo nuevo por subida en `polaris/chat/<channelId>/<uuid aleatorio>`, escrito, comprobado y movido a local si el destino no lo guarda (`placeFile`) | `attachments.ts:43` (`ATTACHMENT_ROOT`), `attachments.ts:248-302` (`storeAttachment`) |
| Miniaturas y posters | **Ya las genera el navegador del emisor** y se escriben al lado como `<path>.poster.jpg` | `attachments.ts:254-260`, `attachments.ts:293`, `attachments.ts:331-346` (`placePoster`) |
| Reenviar | No copia bytes: crea un mensaje nuevo que cita al original (`forwarded: true`, relación `ChatQuote` por `replyToId`) | `lib/chat/messages.ts:1308-1325` |
| Reenviar, efecto secundario | La cita usa `onDelete: SetNull`: si se borra el original, lo reenviado deja de verse | `packages/db/prisma/schema.prisma`, modelo `ChatMessage`, relación `replyTo` |
| Volver a enviar un medio guardado | **Copia los bytes**: lee el archivo y llama otra vez a `storeAttachment`. El comentario lo justifica: dos filas apuntando al mismo archivo harían que borrar un mensaje lo quitara de los dos | `lib/chat/saved-media.ts:108-147` (`readAttachment` y `storeAttachment` en la línea 139) |
| Medios remotos (GIF y similares) | Se descargan y se guardan como archivo nuevo en cada envío | `app/(app)/chat/actions.ts:436-437` (`fetchRemoteMedia` y `storeAttachment`) |
| Borrado | `removeStoredFiles` agrupa por destino y borra; lo comparten los programados | `attachments.ts:607` |
| Limpieza | `tidyChatStorage` quita carpetas de conversaciones que ya no existen o vacías, **nunca** por "nadie apunta a este archivo", para que un fallo en las filas no borre fotos | `attachments.ts:700-716` |
| Hash de contenido o deduplicación | **No existe** en el chat ni en Drive. El único SHA-256 relacionado es el nombre de caché de miniaturas de Drive, que hashea conexión, ruta, fecha y tamaño, no el contenido | `lib/drive-thumbnail.ts:80-81` |
| "Guardar en Drive" desde el chat | No existe hoy (sin coincidencias en `lib/chat` ni en `app/(app)/chat`) | búsqueda en el código |
| Backfill de medios | No se encontró ningún módulo `media-backfill` | búsqueda en el código |

Conclusión: hoy no hay deduplicación que perder. Hay dos fuentes de copias evitables (medios guardados y medios remotos vueltos a enviar) y un fallo de diseño en los reenvíos (borrar el original los vacía).

### 10b.2 Diseño con E2EE

| Mecanismo | Cómo | Qué ve el servidor | Ganancia |
| --- | --- | --- | --- |
| **Blob cifrado con clave por archivo** | Cada archivo se cifra una vez con una clave aleatoria de 256 bits, en bloques de 64 KiB (v1 4.2); la clave y el SHA-256 del claro van dentro del mensaje cifrado | Un blob opaco y su tamaño | - |
| **Reenviar y volver a enviar = nueva referencia** | El mensaje nuevo lleva la misma clave del archivo y el id del blob; el servidor suma una referencia en una tabla `ChatBlob(id, target, path, size, refs)`. No se sube nada | Que dos mensajes apuntan al mismo blob, cosa que ya sabe hoy con las citas | N envíos de un archivo de S bytes pasan de N x S a S |
| **Recuento de referencias** | El blob se borra cuando su recuento llega a 0, en la misma transacción que borra la última fila; `tidyChatStorage` sigue sin borrar por huérfanos y solo informa | - | Resuelve el motivo del comentario de `saved-media.ts`: borrar un mensaje ya no quita el archivo de otro. También el reenvío que se vacía al borrar el original, porque el mensaje reenviado guarda su propia referencia y su propia clave |
| **Deduplicación dentro de lo que ya ve quien tiene la clave** | El cliente calcula `HMAC(K_dedup_usuario, SHA-256(claro))` con una clave derivada de su `AK` y lo manda al subir; si coincide con un blob suyo, se reutiliza | Que **ese usuario** sube dos veces el mismo archivo; nada entre usuarios | Medios remotos repetidos y archivos repetidos de la misma persona |
| **Sin deduplicación entre usuarios** | Se descarta el cifrado convergente (clave derivada del contenido): permite confirmar si alguien tiene un archivo concreto y, con archivos de formato predecible, aprender el resto ("learn-the-remaining-information", Tahoe-LAFS) [94]; el problema está formalizado como cifrado bloqueado por el mensaje [95] | - | Se renuncia a ahorrar entre personas distintas; con datos de gobierno no se negocia |
| **Quién puede añadir una referencia** | El servidor solo acepta una referencia nueva si el blob ya está referenciado en una conversación de la que el emisor es miembro, o en sus guardados, igual que hoy `requireChannel` comprueba el origen de un reenvío | Lo mismo que hoy con un reenvío | Conocer un id de blob no permite sujetarlo para siempre ni adjuntarlo en otra sala; leerlo es imposible sin la clave |
| **Denuncias** | La evidencia de `keepForReports` pasa a ser una referencia más al blob en lugar de mover el archivo | Lo mismo que hoy | Borrar el mensaje denunciado no borra la prueba |
| **Miniaturas** | Siguen generándose en el emisor, como hoy; se cifran con su propia clave dentro del mensaje | Un blob opaco más pequeño | Sin regresión |
| **Destinos (NAS, conexiones, local)** | Igual que hoy: `chatTarget()` decide dónde va el blob y `placeFile` lo escribe. El destino solo guarda blobs cifrados | Lo mismo que el servidor | Mejora: un NAS compartido o una conexión externa dejan de tener fotos en claro |
| **Guardar en Drive** (cuando se añada) | El cliente descifra y sube a Drive como un archivo normal, con los permisos de Drive. Drive no es E2EE y el botón lo dice. No se reutiliza el blob del chat: Drive necesita el claro para sus visores, miniaturas y compartición | Lo que Drive ve de cualquier archivo | - |
| **Sobrecarga del cifrado** | 16 B de etiqueta por bloque de 64 KiB (0,024%) más una cabecera fija | - | Despreciable |

No se encontró una fuente primaria que confirme que WhatsApp reutiliza el mismo blob cifrado al reenviar medios, así que no se afirma nada sobre WhatsApp; el diseño se sostiene por sí mismo.

### 10b.3 La migración como ahorro de espacio

| Paso | Detalle |
| --- | --- |
| Informe previo | Antes de M2, el migrador calcula el SHA-256 de cada archivo en claro y muestra en Administración cuánto se recuperaría (bytes duplicados por conversación y por autor). Solo informa |
| Fusión | En M2, los archivos idénticos **dentro de la misma conversación** o **del mismo autor** se cifran una sola vez y pasan a un único blob con recuento de referencias; desaparecen las copias que crearon los medios guardados y los GIF vueltos a enviar |
| Entre conversaciones distintas | No se fusionan por defecto: el servidor conservaría para siempre el dato "este archivo está en A y en B". Decisión 10 |
| Verificación | El SHA-256 del claro de cada referencia se comprueba contra el blob fusionado antes de borrar ninguna copia (M3) |
| Cuánto | La cifra depende de cada instalación y la da el informe previo; el tope es la suma de todas las copias menos una por archivo |

## 11. Aseguramiento interno (sustituye a la auditoría externa)

### 11.1 Lista de fallos conocidos (cada punto con su prueba en la suite)

| # | Fallo | Qué se exige | Fuente del precedente |
| --- | --- | --- | --- |
| 1 | Reutilización de nonce o clave en AEAD | Nonces derivados, nunca aleatorios de 96 bits sin control; clave por mensaje; prueba que fuerza colisiones | RFC 9420 (derivación de nonces y `reuse_guard`) [21] |
| 2 | Mal uso de AEAD: datos asociados incompletos, compromiso de clave | Datos asociados con conversación, epoch, id, emisor; compromiso de archivos por SHA-256 del claro | Franking de adjuntos de Facebook burlado [49] |
| 3 | Credencial o firma sin verificar, confusión de identificadores | Verificar toda credencial contra `AK` y transparencia; tipos distintos para id de dispositivo y clave | Matrix CVE-2022-39250 (confusión de clave y dispositivo en SAS) [59] |
| 4 | Confusión entre protocolos o tipos de mensaje | Etiquetas de dominio en cada derivación y firma | Matrix CVE-2022-39251 (Olm/Megolm) [59]; ETH sobre Threema, lección 2 [61] |
| 5 | Validación incompleta de commits y épocas | Validación RFC 9420 completa; rechazar épocas pasadas y futuras | RFC 9420 [21] |
| 6 | Welcome y external join sin validar | Validar `GroupInfo` firmado, árbol y permisos; el servidor solo autoriza, no decide claves | RFC 9420 [21]; RFC 9750 sobre el papel del Servicio de Entrega [58] |
| 7 | Downgrade de versión o suite | Versión y suite fijadas por grupo; cambio solo por commit firmado | Telegram MTProto [86] |
| 8 | Repetición, reflexión, reordenación, borrado | Contadores por emisor, detección de huecos, ligado a la conversación | Threema 2023, ataques 3 y 4 [61] |
| 9 | Vuelta atrás del estado local | Estado versionado, monotonicidad | - |
| 10 | Borrado de claves y secreto hacia delante | Borrar secretos MLS usados; `HK` antiguas solo envueltas, nunca en claro en disco | RFC 9420 [21] |
| 11 | Canales laterales de tiempo en JS/WASM | Primitivas de WebCrypto o de bibliotecas en tiempo constante; nada de base64 o comparaciones propias sobre secretos | libolm: base64 con canal lateral de tiempo y firmas maleables (CVE-2024-45192, CVE-2024-45193) [90]; vodozemac CVE-2024-40640 [91] |
| 12 | Aleatoriedad | Solo `crypto.getRandomValues` / RNG del sistema; prueba que falla si se usa `Math.random` en el paquete | Whitepaper de Threema sobre la calidad de la entropía de claves [62] |
| 13 | Negociación de ciphersuite | Lista cerrada; desconocido = rechazo | [87] |
| 14 | Denegabilidad frente a franking | Polaris elige no denegabilidad (firmas) y franking para denuncias; se documenta | [47][49] |
| 15 | Fugas de metadatos | Push cifrado, etiquetas de dispositivo cifradas, recibos reducidos, ids derivados en envoltorios | Threema [62] |
| 16 | Compresión antes de cifrar | Nunca comprimir datos con secretos junto a datos controlables por el atacante | Threema 2023, ataque 7 (canal lateral de compresión en backups) [61] |
| 17 | Impersonación por compromiso de clave efímera | Autenticación ligada a claves de largo plazo en el canal QR | Threema 2023, ataque 1 [61] |
| 18 | Servidor que gestiona la pertenencia | Pertenencia MLS como verdad criptográfica; diferencias visibles | "More is Less" [85] |
| 19 | XSS en el render del mensaje | Render sin HTML crudo, CSP, Trusted Types, fuzzing del parser de Markdown | Signal Desktop CVE-2018-10994 / CVE-2018-11101 [88]; auditoría de Wire [89] |
| 20 | Exportación de identidad que permite clonar | Exportar `AK` solo envuelta y con aviso al resto de dispositivos | Threema 2023, ataque 6 [61] |
| 21 | Copias de seguridad de claves con algoritmo débil | Backup autenticado (AEAD), no solo cifrado | Aviso de matrix-sdk-crypto sobre el algoritmo antiguo [35] |

### 11.2 Revisiones adversariales por área

Cinco revisores separados, que no han escrito el código del área que revisan, cada uno con su lista y acceso al modelo de amenazas:

| Área | Alcance |
| --- | --- |
| Protocolo | Capa de contenido propia (4.2), reparto de `HK`, validaciones de 4.3, uso de la biblioteca MLS |
| Gestión de claves | Cierres, recuperación de la organización y su delegación (3.5), transparencia, QR |
| Migración | Idempotencia, verificación, borrado, vuelta atrás, casos de 8.4 |
| Almacenamiento en el cliente | IndexedDB, almacenes del sistema, varias cuentas, cierre de sesión, ventanas privadas, Service Worker, extensiones nativas de notificación |
| Servidor | Servicio de Entrega, autorización de external commits, API sin texto en claro, registros sin contenido, servicios de Polar y webhooks |

Regla: **cada hallazgo entra primero como prueba que falla** en la suite; el arreglo se acepta cuando esa prueba pasa y se queda para siempre como regresión. Los hallazgos se registran en el libro de vulnerabilidades del repositorio (`docs/vulnerabilities`).

### 11.3 Pruebas

| Tipo | Qué cubre |
| --- | --- |
| Vectores de RFC 9420 | Los del repositorio de implementaciones del grupo de trabajo: tree math, crypto basics, secret tree, message protection, key schedule, PSK, transcript hashes, Welcome, tree operations, tree validation, TreeKEM, messages, passive client [92] |
| Vectores propios | Capa de contenido, envoltorios, segmentos de índice, migración; publicados en el repositorio para que cualquier cliente los compruebe |
| Propiedades | Para cualquier secuencia de altas, bajas, ediciones y borrados: todos los miembros vigentes leen todo lo que deben, ningún expulsado lee nada posterior, el historial migrado es byte a byte igual |
| Fuzzing | Cada parser: mensajes MLS, envoltorios, cabeceras de adjuntos, segmentos de índice, payloads de push, QR, Markdown del render |
| Interoperabilidad | Web, escritorio, Android, iOS y extensión contra los mismos vectores y en conversaciones reales mezcladas, incluidas versiones anteriores soportadas |
| Migración a escala | Conjunto sintético con decenas de millones de mensajes, adjuntos, ediciones, hilos, cuentas borradas, miembros sin `AK`; con cortes de proceso aleatorios a mitad de lote; verificación de recuentos y hashes |
| Caos | Commits concurrentes, dispositivos offline semanas, relojes desfasados, red que reordena, servidor que reinicia a mitad de commit |
| Servidor malicioso simulado | Un Servicio de Entrega de pruebas que intenta cada ataque de 11.1 y la suite exige que el cliente lo detecte |

### 11.4 Puertas de lanzamiento (todas en verde antes de activar)

| Puerta | Condición |
| --- | --- |
| G1 | Los 21 puntos de 11.1 con prueba en la suite, en verde |
| G2 | Las cinco revisiones de 11.2 cerradas sin hallazgos abiertos de severidad media o superior |
| G3 | 100% de vectores RFC 9420 y propios en verde en todos los clientes |
| G4 | Fuzzing de cada parser con el tiempo mínimo acordado sin fallos nuevos |
| G5 | Migración a escala: cero diferencias de recuento y hash, y vuelta atrás probada |
| G6 | Caos y servidor malicioso: sin pérdida de mensajes ni aceptación de ataques |
| G7 | Rendimiento: primer pintado y envío sin regresión medible frente a la versión anterior |
| G8 | Modelo de amenazas revisado y firmado |

Una auditoría externa es opcional y se puede añadir en cualquier momento; no bloquea.

---

## 12. Riesgos

| Riesgo | Mitigación |
| --- | --- |
| Criptografía propia (capa de contenido, delegación de recuperación) | Mínima, con revisor propio, vectores y servidor malicioso simulado |
| JavaScript servido por el servidor | 4.7; se declara |
| PRF desigual entre navegadores | Cierre opcional; nunca el único |
| Estado compartido entre WebView y código nativo (notificaciones) | Almacén de claves nativo desde la fase 1 |
| Canales enormes | Entrada diferida, commits agrupados, bajas automáticas |
| Texto en claro en copias antiguas | Purga explícita (8.5) |
| Integraciones que leían `body` por la API | Nota de versión y miembros de servicio |

---

## 13. Decisiones del propietario (tomadas el 2026-11-21)

| # | Decisión | Resultado |
| --- | --- | --- |
| 1-2 | Recuperación | **El historial no se pierde nunca, en ninguna cuenta.** Cambiar de móvil, de Android a iOS o perder un dispositivo solo pide la contraseña o la passkey: la clave de cuenta se desbloquea con ellas. Si además se olvida la contraseña y se pierden todos los dispositivos, recupera un quórum: administradores de la organización para sus miembros, administradores de la instancia para cuentas personales (con un solo administrador, ese administrador). Cada recuperación queda registrada y se avisa al usuario. Sin opción de salirse. Se descarta que otros miembros reenvíen el historial: la identidad del dispositivo nuevo la avalaría el servidor, que es el adversario. |
| 3 | Retención legal (miembro archivador visible) | Disponible por organización, apagada por defecto; se activa para personas concretas y todos ven el aviso en esas conversaciones. |
| 4 | Vuelta atrás | Instantánea en claro 30 días para revertir si el cifrado falla; después se purga el texto en claro (incluidas las copias anteriores) y queda solo cifrado de extremo a extremo, sin opción de volver. |
| 5 | Clientes antiguos | Sin copia en claro de transición. La activación (fase 14) espera a que las versiones con soporte estén publicadas y verificadas en escritorio, Android, iOS (aprobada en la App Store) y la extensión; desde ese momento una app sin actualizar muestra "Actualiza para ver este chat". Es una puerta de lanzamiento más. |
| 6 | Poscuántico | Desde el inicio: HPKE híbrido con ML-KEM-768 para lo almacenado. |
| 7 | Dispositivos inactivos | Baja tras **30 días** sin conexión por defecto (WhatsApp desconecta enlazados a los 30 días, Signal a los 45); ajustable por el administrador de la instancia o por la organización entre 7 y 90. La reincorporación es automática y no pierde historial. |
| 8 | Solo apps verificadas | Ajuste de instancia (lo fija el administrador de Polaris) y de organización, apagado por defecto; una organización puede endurecer lo que impone la instancia, nunca relajarlo. Referente: Code Verify de Meta para WhatsApp Web; Signal no tiene cliente web por este motivo. Un navegador o sistema comprometido queda fuera del modelo, como en cualquier mensajero. |
| 9 | Canales grandes tras migrar | Grupo creado vacío; cada dispositivo entra al abrir el canal por primera vez y envía su propia actualización. |
| 10 | Fusión de duplicados en la migración | Solo dentro de la misma conversación o del mismo autor. |
| 11 | Velocidad de carga (2026-11-22) | **Los mensajes cargan al instante, como hoy y como en Discord**, en la web también, en un navegador recién abierto y tras días sin entrar. Nada de la espera de WhatsApp Web, que tarda un minuto o más en sincronizar antes de mostrar el chat. Una conversación abierta pide solo la página visible, la descifra en el cliente y la pinta en el primer frame; lo antiguo llega al hacer scroll. Ninguna sincronización completa, reproducción del historial de claves ni índice de búsqueda bloquea la primera pintura. Es una puerta de lanzamiento medida: tiempo hasta ver los últimos mensajes de un canal en una sesión nueva, comparado con el chat sin cifrar. |

---

## 14. Plan por fases actualizado

Resultado de la fase 0 (biblioteca elegida, medidas y riesgos): [chat-e2ee-phase0.md](chat-e2ee-phase0.md).

| Fase | Contenido | Tamaño | Depende de |
| --- | --- | --- | --- |
| 0 | **Hecha** para la biblioteca: OpenMLS 0.9.2 elegida; peso, arranque y coste por tamaño de grupo medidos; hallazgo de commits lineales tras altas masivas [P0]. Queda: Android e iOS reales (solo se aproximaron), estado estacionario del árbol, ritmo del migrador, tamaño de los segmentos de índice e informe de duplicados | M | - |
| 1 | Clave de cuenta, cierres (dispositivo, contraseña con derivación en el cliente, passkey PRF, QR), cambio del flujo de contraseña de `better-auth` sin romper cuentas existentes (se adopta en el siguiente inicio de sesión), almacenes nativos | L | 0 |
| 2 | `ORK` con Shamir, custodios, delegación opcional, integración con `account-recovery-service` y registro de auditoría | L | 1 |
| 3 | Transparencia de claves y verificación del paquete web por extensión y escritorio | L | 1 |
| 4 | Grupos MLS, Servicio de Entrega, capa de contenido, `HK` y envoltorios, todas las funciones de mensajería (ediciones, reacciones, hilos, encuestas, programados, borradores, temporales, chat de reunión) | XL | 1 |
| 5 | Adjuntos por bloques, Service Worker de rangos, visores con bytes, miniaturas en el emisor, notas de voz | L | 4 |
| 6 | Notificaciones: push cifrado, SW, escritorio, iOS NSE, Android | L | 4 |
| 7 | Búsqueda con segmentos de índice compartidos | L | 4 |
| 8 | Polar, miembros de servicio, webhooks, componentes, vistas previas vía servidor con tarjeta cifrada, transcripción y traducción | L | 4 |
| 9 | Canales grandes: entrada diferida, commits agrupados, bajas automáticas, historial para quien entra | L | 4 |
| 10 | Llamadas con claves del exporter MLS en LiveKit; prueba en Safari, Firefox y WebViews | M | 4 |
| 11 | Moderación: reglas de contenido en el cliente, franking, archivo de cumplimiento opcional, controles de organización y evidencia | M | 4, 2 |
| 12 | Migrador (M0-M6), escritura doble, desfase de clientes, Backups previos, instantánea, purga, progreso en Administración | XL | 4-11 |
| 13 | Aseguramiento interno completo (11.1-11.3) en paralelo desde la fase 4; cierre con las puertas G1-G8 | XL | 4-12 |
| 14 | Activación para todas las instancias en una versión; migración automática al actualizar; retirada del código en claro en una versión posterior condicionada al estado | M | 13 |

No hay entrega parcial visible: el usuario no debe ver una versión con funciones de menos. Las fases 1-13 se integran detrás de una bandera interna que no se expone en la interfaz, y se activan juntas en la 14.

---

## Fuentes

Fuentes 1-57: las de la v1, con los mismos números y URL (ver la v1 de este archivo en el historial de git, commit `5e5d7b5809`, sección "Fuentes"). Se usan aquí: 1, 2, 8, 10, 12, 13, 14, 21, 27, 30, 31, 34, 35, 36, 37, 47, 49, 52, 53, 57.

58. RFC 9750, The Messaging Layer Security (MLS) Architecture (abril de 2025) - https://www.rfc-editor.org/rfc/rfc9750.html
59. Albrecht, Celi, Dowling, Jones, "Practically-exploitable Cryptographic Vulnerabilities in Matrix" (ePrint 2023/485) - https://eprint.iacr.org/2023/485.pdf ; resumen de CVE-2022-39250 y CVE-2022-39251 - https://portswigger.net/daily-swig/matrix-address-flaws-that-break-message-encryption-assurances
60. Threema, auditorías de código (Cure53 2020 apps, Cure53 2024 escritorio, FH Münster 2019) - https://threema.com/en/faq/code-audit ; informe Cure53 de Threema Desktop - https://cure53.de/pentest-report_threema-desktop.pdf
61. Paterson, Scarlata, Truong, "Three Lessons From Threema: Analysis of a Secure Messenger" (USENIX Security 2023) - https://www.usenix.org/conference/usenixsecurity23/presentation/paterson ; sitio con los siete ataques y lecciones - https://breakingthe3ma.app/ ; respuesta de Threema - https://threema.com/de/blog/news-angebliche-schwachstellen-statement
62. Threema, Cryptography Whitepaper (multidispositivo con mediador, Ibex, Threema Safe, DualLock, push cifrado, descubrimiento de contactos) - https://threema.com/assets/documents/cryptography_whitepaper.pdf
63. Threema, "New Communication Protocol Ibex" - https://threema.com/en/blog/ibex
64. Threema, "Security Proof of Threema's Communication Protocol" y análisis de Ibex 2023 - https://threema.com/en/blog/security-proof-ibex ; https://threema.com/assets/6-resources/audits/security_analysis_ibex_2023.pdf
65. Threema para autoridades públicas (Work, OnPrem, uso anónimo, consola) - https://threema.com/en/industries/institutions/public-authorities
66. Threema Work para autoridades (administración federal suiza, ejército) - https://threema.ch/en/work/authorities ; versión discrepante sobre el ejército - https://www.bleepingcomputer.com/news/security/swiss-army-bans-all-chat-apps-but-locally-developed-threema/amp/
67. WhatsApp, "Encrypting your WhatsApp chat backup just got easier" (passkeys, 30-10-2025) - https://blog.whatsapp.com/encrypting-your-whatsapp-chat-backup-just-got-easier
68. Messenger Help Center, opciones para restaurar chats cifrados - https://www.messenger.com/help/431055522328649/?locale=en_US
69. Apple Platform Security, seguridad del depósito de iCloud Keychain - https://support.apple.com/guide/security/sec3e341e75d/web
70. Apple, clave de recuperación de la cuenta - https://support.apple.com/109345 ; contacto de recuperación - https://support.apple.com/en-al/102641 ; Advanced Data Protection - https://www.apple.com/legal/privacy/data/en/advanced-data-protection/
71. Google Security Blog, "Google and Android have your back by protecting your backups in the Cloud" (2018) - https://security.googleblog.com/2018/10/google-and-android-have-your-back-by.html ; Cloud Key Vault - https://developer.android.com/about/versions/pie/security/ckv-whitepaper
72. MSC3814, Dehydrated Devices with SSSS - https://github.com/uhoreg/matrix-doc/blob/shrivelled_sessions/proposals/3814-dehydrated-devices-with-ssss.md
73. Element, cómo asegurar que tienes una clave de recuperación - https://docs.element.io/latest/element-support/device-verification/how-to-ensure-you-have-a-recovery-key/
74. Element, caso Tchap - https://element.io/case-studies/tchap
75. Element, BwMessenger para la Bundeswehr - https://element.io/blog/bwmessenger-goes-live-for-bundeswehr/
76. Element, NATO NI2CE Messenger - https://element.io/blog/nato-ni2ce-messenger-utilises-the-power-of-decentralised-communication/
77. Wire docs, Legal hold - https://docs.wire.com/latest/developer/reference/team/legalhold.html
78. Wire Support, "What is legal hold?" - https://support.wire.com/hc/en-us/articles/360002018278-What-is-legal-hold
79. Microsoft Learn, Teams encryption (E2EE incompatible con grabación de cumplimiento y eDiscovery) - https://learn.microsoft.com/en-us/microsoftteams/teams-encryption
80. RFC 9807, The OPAQUE Augmented PAKE Protocol (julio de 2025) - https://www.rfc-editor.org/rfc/rfc9807.html
81. W3C, Web Authentication Level 3 (Recommendation, 25-08-2026), sección 10.1.4 extensión PRF - https://www.w3.org/TR/webauthn-3/#prf-extension
82. Chromium blink-dev, "Intent to Ship: WebAuthn PRF extension" - https://groups.google.com/a/chromium.org/g/blink-dev/c/iTNOgLwD2bI
83. Apple Developer Forums, PRF no soportado en el flujo entre dispositivos de Safari - https://developer.apple.com/forums/thread/774112
84. Mozilla Bugzilla 1985777 (PRF en Firefox para macOS) - https://bugzilla.mozilla.org/show_bug.cgi?id=1985777
85. Rösler, Mainka, Schwenk, "More is Less: On the End-to-End Security of Group Chats in Signal, WhatsApp, and Threema" (ePrint 2017/713, EuroS&P 2018) - https://eprint.iacr.org/2017/713
86. Albrecht, Mareková, Paterson, Stepanovs, "Four Attacks and a Proof for Telegram" (IEEE S&P 2022, ePrint 2023/469) - https://eprint.iacr.org/2023/469
87. draft-ietf-mls-pq-ciphersuites, ML-KEM and Hybrid Cipher Suites for MLS - https://datatracker.ietf.org/doc/draft-ietf-mls-pq-ciphersuites/
88. Signal Desktop, CVE-2018-10994 (XSS por mensaje) - https://www.incibe.es/en/incibe-cert/early-warning/vulnerabilities/cve-2018-10994 ; CVE-2018-11101 - https://nvd.nist.gov/vuln/detail/CVE-2018-11101
89. X41 D-Sec y Kudelski, auditoría de aplicaciones de Wire (2018) - https://x41-dsec.de/security/report/2018/03/06/projects-x41-wire-phase2/ ; auditoría criptográfica (2017) - https://www.x41-dsec.de/reports/Kudelski-X41-Wire-Report-phase1-20170208.pdf
90. Matrix.org, "libolm deprecation" (CVE-2024-45192, CVE-2024-45193) - https://matrix.org/blog/2024/08/libolm-deprecation/
91. NVD, CVE-2024-40640 (vodozemac, base64 sin tiempo constante) - https://nvd.nist.gov/vuln/detail/CVE-2024-40640
92. MLS WG, vectores de prueba de interoperabilidad - https://github.com/mlswg/mls-implementations/blob/main/test-vectors.md
94. Tahoe-LAFS, ataque de Drew Perttula y Brian Warner (confirmación de archivo y learn-the-remaining-information con cifrado convergente) - https://tahoe-lafs.org/hacktahoelafs/drew_perttula.html
95. Bellare, Keelveedhi, Ristenpart, "Message-Locked Encryption and Secure Deduplication" (EUROCRYPT 2013, ePrint 2012/631) - https://eprint.iacr.org/2012/631
P0. Fase 0 de Polaris: elección de la biblioteca MLS y medidas - [chat-e2ee-phase0.md](chat-e2ee-phase0.md)
93. MDN, cuotas de almacenamiento y criterios de desalojo (ventanas privadas, `persist()`, desalojo de Safari a 7 días) - https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria

### Lo que no se pudo verificar

- Fuentes leídas solo por resúmenes de búsqueda, no enteras: 59 (lista completa de ataques), 64 (análisis de Ibex), 66, 69, 70, 72-76, 79, 82-88. La 62 (whitepaper de Threema) sí se leyó en texto completo; la 61 y la 93, por página.
- Cómo resuelven Tchap, BwMessenger y NI2CE la recuperación organizativa: no hay documentación pública encontrada; no se afirma nada.
- Un mecanismo de acceso de la organización a los mensajes en Threema Work u OnPrem: no se encontró; tampoco se afirma que no exista.
- La auditoría de Threema OnPrem por terceros: no se encontró.
- Soporte real de PRF por navegador y autenticador hoy: fuentes contradictorias; medir en la fase 0.
- Todas las cifras de rendimiento marcadas como estimación: se miden en la fase 0.
- Compatibilidad de navegadores con el E2EE de LiveKit (v1): sigue sin verificar.
