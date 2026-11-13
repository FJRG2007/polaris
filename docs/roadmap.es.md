# Hoja de ruta

[Read in English](roadmap.md) - [Volver al README](../README.es.md)

Hacia dónde va Polaris: las decisiones de plataforma que afectan a todos los
clientes y un resumen de la hoja de ruta de cada área, con el enlace a su
archivo completo. El detalle está en los archivos de cada área; esta página es
el índice.

## Dirección de la plataforma

Decidida el 2026-11-13.

### Un núcleo compartido en Rust

Una sola biblioteca en Rust, `crates/polaris-client`, reúne lo que necesita
cualquier cliente: el cliente de la API, el inicio de sesión, la caché local y
la conexión en tiempo real. La usa primero la app de escritorio, y las futuras
apps móviles nativas usarán el mismo crate. Está planificada; todavía no existe
en el repositorio.

### La app de escritorio pasa de Electron a Tauri 2

La app de escritorio pasa a ser un contenedor de Tauri 2 sobre la misma
interfaz web que muestra hoy. La versión con Tauri se construye en paralelo a la
de Electron, se publica como beta y se sigue módulo a módulo en el
[registro de paridad del escritorio](desktop-tauri-parity.md).

Electron solo se retira cuando se cumple todo esto:

- Los usuarios no notan ningún cambio.
- El tiempo de arranque y la memoria no son peores que con Electron, medidos.
- El CI/CD sigue siendo igual de rápido.

### No hay planes de reescribir la interfaz en GPUI

Se evaluó GPUI (el framework de interfaz por GPU de Zed, que Discord anunció el
2026-11-04 para reescribir su app de escritorio) para una interfaz nativa
completa, y no está planificado:

- Supone reescribir todas las pantallas, y los usuarios verían el cambio.
- El panel web, la extensión del navegador y el móvil seguirían necesitando la
  interfaz actual, así que Polaris mantendría dos interfaces.
- GPUI no tiene una versión 1.0 estable.

Solo se reconsidera si una pantalla muy usada sigue lenta con Tauri, medida, y
entonces solo para esa pantalla.

## Escala y plataforma de apps

Decidido el 2026-11-13. El objetivo es el mismo Polaris desde un servidor en
casa hasta gobiernos y empresas con millones o miles de millones de usuarios,
con cientos o miles de apps oficiales y, como en Home Assistant, potencialmente
millones de apps de la comunidad.

### Velocidad del cliente: un núcleo en Rust en cada cliente (planificado)

El núcleo en Rust de arriba lo comparten todos los clientes: nativo en el
contenedor de escritorio y en las apps móviles, y compilado a WebAssembly en el
navegador para el trabajo pesado del cliente - sincronización, caché local e
índice de búsqueda, criptografía y uso sin conexión. Así la web y los clientes
nativos ejecutan el mismo código. Nada de esto existe todavía.

### La interfaz de las apps sigue siendo web y aislada (en parte planificado)

Las apps de la comunidad no pueden meter código nativo en el cliente de cada
usuario: a esa escala es una frontera de seguridad que nadie puede revisar, y
cada autor tendría que escribir Rust. Zed, que está hecho con GPUI, limita sus
extensiones a WebAssembly con una interfaz reducida por el mismo motivo.

Lo que existe hoy:

- El catálogo del marketplace es un conjunto fijo de apps definido en código
  (`dashboard/apps/web/src/lib/apps/catalog.ts`). Todavía no hay apps de la
  comunidad.
- Las apps propias instalables (Servidores de juegos, Places, Calendario, CRM y
  otras) son paquetes que genera `dashboard/packages/app-host/bundler`, publica
  el CI y solo se descargan al instalarlas. Se cargan en el propio proceso del
  panel y se comprueban contra una API de host versionada antes de ejecutar
  nada de su código; ver [el contrato de paquetes de apps](app-bundles-contract.md)
  y [el plan de apps instalables](installable-apps-plan.md).
- El núcleo del panel solo llega a una app a través de su registro de
  extensiones (`dashboard/apps/web/src/lib/app-extensions/registry.ts`), y una
  prueba de build falla si el núcleo importa código de una app directamente.
- Las apps que son un servicio propio (una app `compose-template`) se instalan
  como un stack de compose a través de Deploy, en sus propios contenedores.

Planificado, más allá de eso: la interfaz de terceros se dibuja en una
superficie web aislada, con un manifiesto, permisos declarados y un SDK, y la
parte de servidor de una app de la comunidad se ejecuta en su propio
contenedor.

### Pantallas propias muy usadas (planificado)

Las listas de chat y correo, la cuadrícula del calendario y las tablas grandes
reciben primero virtualización, workers y el núcleo en WebAssembly. Un
renderizado nativo (GPUI en escritorio, SwiftUI o Jetpack Compose en móvil) se
plantea pantalla por pantalla, y solo cuando una medición muestra que la
versión web no cumple su presupuesto.

### Móvil (planificado)

Contenedores nativos, SwiftUI en iOS y Kotlin con Jetpack Compose en Android,
sobre el mismo núcleo en Rust. Es la parte de la dirección de Discord que
encaja con Polaris.

### La escala del servidor va por separado

Lo que existe hoy:

- Las tareas programadas que no pueden hacer dos ejecutores a la vez toman un
  bloqueo en la base de datos (`dashboard/apps/web/src/lib/cron/lease.ts`),
  porque durante una actualización atienden dos contenedores web a la vez.
- Las actualizaciones en vivo de Chat, Tareas, Correo, Office y otras pantallas
  van por un bus dentro del proceso, así que un solo contenedor del panel las
  atiende todas.
- Los servicios desplegados escalan hasta diez copias en un servidor, con
  autoescalado en ese servidor.

Lo planificado está en la
[sección de escalado de la hoja de ruta de Deploy](deploy-roadmap.md#12-scale-out-for-a-customer-leaving-vercel-assessed-2026-10-08):
copias de un servicio en varios servidores, una entrada con balanceo entre
ellos, caché en el borde sin Cloudflare, cuotas por cliente, y Polaris en más de
un contenedor pasando el bus de actualizaciones a `LISTEN/NOTIFY` de Postgres.

## Hojas de ruta por área

Cada resumen sale del archivo enlazado, que está en inglés. Cuando el archivo de
un área no tiene una lista de lo que no se hará, el resumen lo dice.

### Agentes

Fuente: [docs/agents-roadmap.md](agents-roadmap.md)

- **Hecho:** ejecuciones en segundo plano sobre repositorios de GitHub
  (disparadores por mención, issue, pull request, revisión y checks fallidos;
  modos del runtime; políticas de push y shell por repositorio, cuenta e
  instalación; la puerta de calidad antes del push; una cadena de modelos de
  respaldo; límites de uso). Sesiones en vivo de un CLI en un contenedor, en un
  servidor propio o en una máquina compartida, con una rama nueva cada una, un
  estado "Te necesita" a partir de los hooks de la herramienta, control del
  terminal desde el navegador y el servidor MCP de Polaris para iniciar y
  dirigir otras sesiones.
- **Siguiente, en orden:** un aviso cuando un agente te necesita o termina; que
  el trabajo sobreviva a Detener; el diff de la sesión; hacer push y abrir un
  pull request desde la sesión; devolver al agente los comentarios del diff y
  el CI fallido; un tablero de sesiones; un script de preparación del
  repositorio; una tarea a varios agentes; tokens y coste por sesión; un botón
  para responder a una petición de permiso; variables y secretos para
  sesiones.
- **Más adelante:** vista previa en vivo de la app que se construye, un modo de
  planificar primero, pausar y reanudar, automatizaciones programadas, empezar
  desde Chat, una política de salida de red, servidores MCP adicionales por
  repositorio, CLIs y modelos permitidos, y archivos en un prompt.
- **No planificado:** el archivo no marca nada como no planificado.

### Chat

Fuente: [docs/chat-roadmap.md](chat-roadmap.md)

- **Hecho:** espacios, canales, mensajes directos, grupos, hilos, reacciones,
  búsqueda, notas de voz y llamadas con pantalla compartida; modo lento;
  silenciar, expulsar y vetar; bloquear; marcar como no leído; enlaces de
  Polaris dibujados como lo que señalan; emoji propios por espacio; un selector
  rápido; paneles redimensionables. En llamadas: volumen por persona,
  grabación, audio combinado para dispositivos en una sala, manos levantadas y
  reacciones, volumen y ventana flotante de una emisión, fondos, y ver una
  llamada sin unirse.
- **Siguiente:** bots (P0), con webhooks primero; un aviso de "hablas con el
  micrófono silenciado" y seguir un cambio de dispositivo en plena llamada
  (P0); registro de auditoría del espacio, dominios de confianza, retención de
  mensajes, mensajes temporales, pulsar para hablar, mantener la pantalla
  encendida, avisos de conexión y prueba de dispositivos antes de entrar (P1).
  El cifrado de extremo a extremo es P1 y XL, primero mensajes directos y
  grupos, activable por conversación. El consentimiento de grabación sigue
  abierto como ajuste de administrador.
- **No planificado:** calidad según número de asistentes y paginación de la
  cuadrícula (las llamadas tienen un máximo de 8), transcripción en vivo, salas
  separadas, llamada por SIP y grabación en el servidor. La primera versión de
  los bots no tiene pasarela de eventos, comandos de barra ni interacciones.

### CRM

Fuente: [docs/crm-roadmap.md](crm-roadmap.md)

- **Hecho:** empresas, personas y oportunidades con campos personalizados;
  tabla, vistas guardadas y tablero Kanban sobre más de 100k registros; edición
  masiva, fusión y restauración; una línea de tiempo con notas y tareas; flujos
  de trabajo, paneles, previsión y registro de auditoría; roles con alcance por
  fila y campos ocultos; importación y exportación CSV; avisos de duplicados.
- **Siguiente:** objetos personalizados, sincronización de calendario y una API
  pública con claves (P0 pendientes); relaciones más completas y el correo en
  el registro (P0 parciales); campos de resumen, plantillas y secuencias de
  correo, y webhooks salientes (P1).
- **No planificado:** el archivo no marca nada como no planificado; entre sus
  P2 están una vista de calendario, aprobaciones, territorios, enriquecimiento,
  conversión de divisas y una app móvil nativa.

### Deploy

Fuente: [docs/deploy-roadmap.md](deploy-roadmap.md)

- **Hecho:** fuentes de GitHub con despliegue automático, entornos de vista
  previa por pull request y vuelta atrás; builds con Dockerfile, Nixpacks,
  estáticos y por detección de stack; dominios, certificados, red privada,
  balanceo y proxies TCP; entornos y variables compartidas; logs, métricas,
  comprobaciones de salud y alarmas; copias y autoescalado en un servidor;
  bases de datos gestionadas con copias, restauración y actualizaciones;
  servidores remotos por SSH; notificaciones, permisos, estimaciones de uso y
  coste, una API y un CLI.
- **Siguiente, en el orden que sugiere el archivo:** despliegues sin corte para
  servicios con un puerto publicado; un comando previo al despliegue y luego
  reutilizar la caché de build; desplegar desde un archivo Compose del
  repositorio; campos de etapa y argumentos de build, exportar `.env` y
  políticas de reinicio; fuentes de GitLab y Gitea. El plan de escalado (copias
  en varios servidores, una entrada entre servidores, caché en el borde,
  cuotas, Polaris en varios contenedores) va en cuatro fases.
- **No planificado:** el archivo no marca nada como no planificado.

### Drive

Fuente: [docs/drive-roadmap.md](drive-roadmap.md)

- **Hecho:** conexiones de almacenamiento desde discos locales a S3, NAS y
  nubes; una unidad privada por cuenta y una por organización; enviar y
  compartir elementos con roles, notas y caducidad; enlaces públicos con
  contraseña, límites y registro de accesos; puntos de entrega, fragmentos,
  papelera, borrados programados, edición de hojas de cálculo y anotación de
  PDF.
- **Siguiente:** primero un servidor WebDAV y luego el versionado de archivos
  (P0); bloqueo de archivos, búsqueda en el contenido, volver a compartir y
  cuota por cuenta (P1); un cliente de sincronización de escritorio cuando
  exista WebDAV.
- **No planificado:** un índice espejo de archivos y una fila de base de datos
  por archivo. Los clientes móviles, la federación y las carpetas cifradas de
  extremo a extremo siguen en P2.

### Correo

Fuente: [docs/mail-roadmap.md](mail-roadmap.md)

- **Hecho:** un filtro de correo no deseado local que aprende por buzón;
  importación y exportación `.mbox` y `.eml`; reenviar como acción de un
  filtro; colores de carpeta; buzones compartidos que entrega una
  organización.
- **Siguiente, en orden:** migración por IMAP, plantillas de mensaje, webhooks
  con registro de entregas, una pantalla de contactos y una dirección de
  reenvío fija.
- **No planificado:** todo lo que corresponde a ser el servidor de correo
  (conectar dominios, enrutar y rechazar en SMTP, envíos salientes) y el acceso
  delegado al buzón de otra cuenta.

### Office

Fuente: [docs/office-roadmap.md](office-roadmap.md)

- **El plan, en orden:** el modelo de documento compartido, compartir y el
  transporte con Yjs; Docs; Sheets sobre Univer con las tablas dinámicas, los
  gráficos y el conversor `.xlsx` de GenOffice; Diagrams; un tipo de documento
  Comparación estructurado; Slides al final. El archivo es el plan y el
  registro de decisiones; no marca qué pasos están hechos.
- **No planificado:** tldraw (su licencia exige una licencia comercial de pago
  o una marca de agua); los contenedores de Electron y el empaquetado de
  GenOffice. Las apps de Office de escritorio y móvil quedan fuera por ahora.
  draw.io puede llegar más adelante como segundo tipo de diagrama.

### Telemetría

Fuente: [docs/telemetry-roadmap.md](telemetry-roadmap.md)

- **Hecho:** recepción compatible con Sentry con claves por proyecto, reglas de
  emisores y retención; agrupación de incidencias, sintaxis de búsqueda,
  resolver, regresiones e ignorar por tiempo; asignados, acciones masivas,
  comentarios; pilas de llamadas, rastro y contextos de cada evento; listas de
  versiones y entornos; reglas de alerta entregadas como notificaciones de
  Polaris.
- **Siguiente:** equipos como propietarios, límites de ritmo y filtros de
  entrada; fusionar y separar, búsquedas guardadas y reglas de propiedad; source
  maps, adjuntos y comentarios de usuarios; detalle y salud de versiones;
  alertas por métricas, acciones con webhook y un resumen semanal.
- **No planificado aquí:** monitorización de rendimiento, comprobaciones de
  disponibilidad y grabación de sesiones, que son de otras apps.

### Watch

Fuente: [docs/watch-roadmap.md](watch-roadmap.md)

- **Hecho:** métricas en bruto y agregadas por hora, vigilancia de
  contenedores, un borde que vuelve a publicar sus propias rutas, e historial
  de cortes de internet con disponibilidad, mapa de calor y exportación CSV.
- **Siguiente:** los dos sondeos bajo el planificador con bloqueo, una tabla de
  historial de comprobaciones, disponibilidad a 24 h, 7 d y 30 d, y
  comprobación de palabra clave y códigos de estado (P0); avisos de caducidad
  de certificados, intervalos por monitor, ventanas de mantenimiento,
  monitores TCP y DNS, y una URL de latido (P1); incidentes, una página de
  estado pública, silenciar un monitor y métricas del host leídas por SSH (P2).
- **No planificado:** un agente instalado canalizando un script a una shell,
  sondas desde varias regiones, plantillas de mensaje por métrica, y alertas
  sin intervalo de repetición ni enfriamiento.

### Registro de cobertura del panel

Fuente: [dashboard/ROADMAP.md](../dashboard/ROADMAP.md)

- **Hecho:** las fases de construcción, desde la estructura del workspace hasta
  los flujos de CI; las interacciones del explorador de Drive; fragmentos y
  puntos de entrega de texto; el Vault compatible con Bitwarden; las apps de
  Contenedores y Servidores; la frontera entre ediciones, la edición completa
  por defecto y las actualizaciones desde la interfaz a través de hostd; el CLI
  `plr`; Consumo; Tareas, Agentes, Notas, Chat, Código y Telemetría.
- **Abierto en el registro:** acceso de emergencia del Vault, sincronización en
  vivo e informe de contraseñas filtradas; logs, imágenes y stacks de compose
  de contenedores; inicio de sesión con certificados de OpenSSH y editar un
  servidor; Kubernetes (solo esbozos); imágenes con firma verificada para las
  actualizaciones; adjuntos en tareas; enlazar issues, comentar diffs y abrir
  pull requests en Código; source maps y trazas de rendimiento en Telemetría;
  pruebas completas contra NAS, Docker y SSH reales. Algunas líneas antiguas de
  la lista (almacenamiento, compartir y solicitudes de archivos de Drive) siguen
  sin marcar allí aunque la hoja de ruta de Drive las da por hechas; el archivo
  del área es el registro más reciente.
- **No planificado:** pizarras, mapas mentales, clips, IA, tareas por correo,
  revisión de pruebas, vistas de mapa y de carga de trabajo, y carteras en
  Tareas.

## Cómo se mantiene esta hoja de ruta

- El detalle está en los archivos de cada área; esta página es el índice.
- Esta página se actualiza en el mismo cambio que completa o descarta un
  elemento, para que nunca se quede atrás respecto al archivo que resume.
- Una decisión que cambia la dirección de la plataforma se añade aquí con su
  fecha.
