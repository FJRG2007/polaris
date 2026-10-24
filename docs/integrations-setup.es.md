# Configurar integraciones

[Read in English](integrations-setup.md) - [Volver al README](../README.es.md)

Dónde pulsar, qué pegar y qué permite cada servicio. La mayoría los configura
una vez un administrador en **Gestión > Integraciones e IA > Integraciones**:
pulsa **Preparar** en una tarjeta, sigue los enlaces numerados y pega lo que te
da el servicio. Lo que se configura ahí funciona en todas partes a la vez.

Cuando un servicio inicia sesión de personas, la tarjeta muestra una **URI de
redirección autorizada** con un botón para copiarla. Pégala en el servicio tal
cual: el servicio rechaza una autorización que llegue desde cualquier otra
dirección.

## GitHub

Permite que la gente conecte su GitHub, inicie sesión con él y despliegue sus
repositorios, y da su identidad a los agentes de programación.

1. Elige **Crear app** y después **Crear GitHub App**. GitHub pide que
   confirmes y luego que elijas a qué repositorios puede acceder la app.
2. O elige **App existente** y pega su App ID, la clave privada (el contenido
   del archivo `.pem`), el Client ID y el secreto del cliente.

Para desplegar también sirve un token de acceso personal: un token detallado
sobre los repositorios que quieras desplegar, con Contents: Read y Deployments:
Read and write. Si este Polaris no tiene una dirección que GitHub pueda
alcanzar, la app se crea sin webhook; los disparadores de agentes lo necesitan,
y puedes añadirlo en GitHub cuando haya un dominio.

## Google

Da a cada persona un botón Conectar para su propia cuenta de Google. Sus
eventos aparecen en el calendario, de solo lectura, y pueden iniciar sesión con
la cuenta vinculada si lo permites. En la tarjeta, sigue los enlaces en orden:
rellena la pantalla de consentimiento (llama a la app exactamente Polaris),
añade el dominio autorizado (Google rechaza una dirección IP, así que hace falta
un nombre de dominio), demuestra que el dominio es tuyo, crea un cliente OAuth
de tipo aplicación web con la URI de redirección, activa la API de Calendar y
la API de Tasks, y publica la app. Pega el Client ID y el secreto del cliente.
Hasta que la app esté verificada, la gente tiene que pasar antes el aviso de
Google.

## Microsoft

Da a cada persona un botón Conectar para su cuenta de Microsoft, para que su
OneDrive pueda ser destino de copias de seguridad. Registra una aplicación para
cuentas de organización y personales, pega la URI de redirección en su
plataforma Web y añade el permiso delegado Files.ReadWrite. Pega el ID de
aplicación (cliente) y el valor del secreto (no su id).

## Dropbox

Permite guardar copias de seguridad en Dropbox. Crea una app con acceso
limitado a una carpeta de app, pega la URI de redirección y concede
account_info.read, files.metadata.read/write y files.content.read/write antes
de vincular. Pega la clave y el secreto de la app.

## Cloudflare

Polaris escribe los registros DNS de tus zonas y da a cada app su propio túnel,
sin abrir puertos. Conecta un token de API para todo, solo para DNS o solo para
túneles. Un token de conector (Zero Trust > Networks > Tunnels > Install
connector) ejecuta en su lugar un único túnel para todo el servidor.

## ngrok

Ejecuta un agente de ngrok en este servidor que reenvía el tráfico entrante a
Polaris. Pega tu authtoken. Un dominio reservado (plan de pago de ngrok) da una
dirección estable.

## DuckDNS

Apunta un subdominio gratuito `<nombre>.duckdns.org` a la IP pública de este
servidor y lo mantiene al día, y sirve como base comodín para los subdominios
de las apps. Escribe el subdominio y pega el token que aparece arriba en la
página de DuckDNS al iniciar sesión. **Sincronizar** apunta el registro a la IP
actual al momento.

## Steam

Permite vincular la cuenta de Steam para que los servidores de juegos
reconozcan a cada persona. No hay que registrar nada: actívalo. Una clave de la
Web API es opcional y muestra el nombre y el avatar de una cuenta vinculada en
lugar de su id de Steam.

## Epic Games

Permite vincular la cuenta de Epic para que los servidores de juegos reconozcan
a cada persona. Es la configuración más larga de la pantalla: crea un producto,
un cliente con la URI de redirección y la aplicación vinculada a ese cliente;
verifica tu dominio; envíala a revisión. Hasta que pase la revisión, solo
pueden autorizar las cuentas de tu propia organización de Epic. Pega el id y el
secreto del cliente.

## Minecraft

Permite vincular la cuenta de Minecraft para abrir un servidor a alguien por su
nombre. Necesita su propia aplicación, distinta de la de Microsoft: regístrala
para cuentas personales de Microsoft con la URI de redirección y solicita la
API de Minecraft, que Microsoft aprueba aplicación por aplicación. Pega el id
del cliente y el valor del secreto.

## Discord

Permite vincular la cuenta de Discord para que los servidores de juegos
reconozcan a cada persona. Crea una aplicación, registra la URI de redirección
en OAuth2 > Redirects y pega el id y el secreto del cliente de la pestaña
OAuth2. Iniciar sesión con Discord es un interruptor aparte en la tarjeta, y
empieza desactivado.

## Spotify

Permite mostrar qué está escuchando cada persona y escuchar a la vez. Crea una
app en el panel de desarrolladores de Spotify con los valores que lista la
tarjeta y Web API marcada, añade en User Management a cada persona que vaya a
vincular y pega el id y el secreto del cliente. Spotify exige una dirección
https para Polaris, y escuchar a la vez requiere Premium.

## Tenor y GIPHY

Añade la búsqueda de GIF y stickers al selector de Chat. Conecta cualquiera de
los dos: Tenor usa una clave de API de Google Cloud con la API de Tenor
activada, GIPHY la clave de API de una app de GIPHY. Un GIF elegido se guarda en
Polaris, así que las conversaciones nunca piden nada al servicio.

## VirusTotal

Analiza los archivos subidos a tus puntos de entrega y te avisa cuando algo se
marca; elige si una detección bloquea, pone en cuarentena o solo avisa. Pega la
clave de la Public API de tu perfil de VirusTotal.

## Criminal IP

El cortafuegos pregunta a Criminal IP por las direcciones de tu tráfico y
bloquea las que cumplen las condiciones que elijas, en segundo plano y con
caché. Pega la clave de API de la página My Information.

## Proveedores de IA

Anthropic, OpenAI, Google Gemini, xAI, DeepSeek, Moonshot AI, Groq, Cerebras y
OpenRouter tienen su propia lista. Cada persona añade sus claves en **Cuenta >
Claves de IA**, y un administrador añade las del despliegue en **Gestión >
Integraciones e IA > Claves de IA**. Las claves se prueban de arriba abajo; se
usa la primera cuyo proveedor sirve el modelo. La misma página guarda las
cuentas de agente, que inician sesión de un agente de programación en sus
sesiones.

## Asistentes de IA

Claude, Cursor, Visual Studio Code, OpenCode y otros clientes MCP se conectan
como tú desde **Cuenta > Asistentes de IA**. Consulta
[Conectar asistentes de IA](connecting-ai-assistants.es.md).

## Dispositivos de Lugares

Los dispositivos se conectan por lugar: abre **Lugares > Aparatos** y elige
**Conectar dispositivo**. Elige lo que tienes; cada opción dice si funciona en
la misma red o desde donde sea, y lista sus pasos.

| Opción | Alcance | Qué le das |
| --- | --- | --- |
| App Smart Life / Tuya Smart | Desde donde sea | El User Code de la app (Yo > engranaje > Cuenta y seguridad) y después escanear con la misma app el código que muestra Polaris |
| Proyecto de Tuya Cloud | Desde donde sea | Access ID, Access Secret y centro de datos de un proyecto de la consola Tuya IoT vinculado a tu cuenta de la app |
| Tapo en tu propia red | En la misma red | La IP del dispositivo y el correo y la contraseña de la app Tapo, una conexión por dispositivo |
| Kasa en tu propia red | En la misma red | La IP del dispositivo; la cuenta de TP-Link solo con firmware reciente |
| Shelly en tu propia red | En la misma red | La IP del Shelly, y su contraseña si le pusiste una |
| Hue Bridge | En la misma red | La IP del bridge; pulsa su botón de enlace y después Conectar antes de 30 segundos |
| Hub DIRIGERA (IKEA) | En la misma red | La IP del hub; elige Conectar y pulsa el botón de acción del hub antes de un minuto |
| Gree+ (red local) | En la misma red | Nada, o la IP o MAC de una unidad; las unidades tienen que estar configuradas antes en la app Gree+ |
| Philips Air+ (red local) | En la misma red | Nada, o la dirección de una unidad; los purificadores tienen que estar configurados antes en la app Philips Air+ |
| Cuenta Philips | Desde donde sea | Un código que Philips te envía por correo; no oficial, porque Philips no publica una API |
| Philips Dynalite (pasarela Dynet) | En la misma red | La IP de la pasarela y los números de área que quieres traer |
| Home Assistant | En la misma red | La dirección a la que lo abres y un token de acceso de larga duración de tu página de perfil |
| Cuenta de SwitchBot | Desde donde sea | El token y la clave secreta de las opciones de desarrollador de la app SwitchBot |
| Cuenta de Nuki Web | Desde donde sea | Un token de API de Nuki Web que pueda ver y manejar tus cerraduras |
| Nuki en tu propia red | En la misma red | La dirección y las credenciales del bróker MQTT que pusiste en la app Nuki |
| Un bróker en tu propia red | En la misma red | La dirección y las credenciales de un bróker MQTT en el que los dispositivos se anuncian |

Da a cada dispositivo una dirección fija en tu router cuando puedas, para que
siga respondiendo en la dirección que escribiste. Las bombillas Hue Bluetooth y
los televisores Philips aparecen en la lista pero no se pueden conectar; la
pantalla explica por qué.

## Linear y Jira

Trae las incidencias de un gestor a tu tablero de Tareas como tareas, con su
referencia. Abre **Cuenta > Cuentas conectadas**, busca **Gestores de tareas** y
elige **Conectar un gestor**. Elige el gestor, ponle nombre y elige el espacio
y la lista donde caen sus incidencias.

- Linear: una Personal API key (Linear > Settings > Security & access > Personal
  API keys). Opcionalmente la clave de un equipo, como ENG; vacía trae todas las
  incidencias que la clave puede ver.
- Jira: el sitio (tu-empresa.atlassian.net), el email de la cuenta y un API
  token (id.atlassian.com > Security > Create and manage API tokens).
  Opcionalmente una consulta JQL; vacía trae todo, lo más nuevo primero.

**Devolver los cambios de estado** hace que mover una tarea aquí mueva la
incidencia allí. Empieza apagado. **Traer ahora** trae los cambios al momento, y
desconectar deja las tareas donde están.

## iCloud, Nextcloud y otros calendarios CalDAV

En Calendario, elige **Añadir calendario > Servidor CalDAV**. Elige iCloud,
Fastmail, Yahoo, Nextcloud (escribe su dirección) u otro servidor, y luego tu
usuario y una clave de app; **Cómo crear una contraseña de app** abre los pasos
del propio proveedor. iCloud rechaza la contraseña de tu Apple Account. Los
calendarios aparecen según se sincronizan y quedan al día en ambos sentidos.

**Suscribirse por URL (.ics)** acepta cualquier calendario que publique un enlace
.ics o webcal, de solo lectura.

## Entrada: Telegram, WhatsApp, Discord y Slack

Las conversaciones de estas plataformas en un solo sitio, respondidas desde
Polaris. Instala **Puente de mensajería** desde **Apps > Catálogo**; entonces
aparece **Gestión > Entrada**. Elige **Conectar canal**, una plataforma y cómo
conectarla.

| Plataforma | Cómo | Qué le das |
| --- | --- | --- |
| Telegram | Un bot de @BotFather | El token que te da @BotFather. Un bot no puede iniciar un chat: la persona abre tu bot y envía /start primero |
| WhatsApp (QR) | Tu teléfono, vinculado por QR | Nada: elige **Mostrar QR** y luego WhatsApp > Dispositivos vinculados > Vincular un dispositivo. Gratis pero no oficial; usa un número de repuesto |
| WhatsApp Cloud | La API oficial de Meta, de pago | El token de acceso de Meta y el id del número de la página de configuración de la API de WhatsApp; apunta su webhook a este Polaris |
| Discord | Una aplicación con bot | El token del bot del Developer Portal. Polaris muestra lo que falta: **Añadir el bot a un servidor** y los dos intents privilegiados que hay que activar en Bot > Privileged Gateway Intents |
| Webhook de Discord | Avisos en un sentido | Edit > Integrations > Webhooks > New Webhook > Copy Webhook URL del canal |
| Slack | Una app del workspace | Su Bot User OAuth token (empieza por xoxb-) |
| Webhook de Slack | Avisos en un sentido | La URL de un Incoming Webhook de tu app de Slack |

## UniFi UNAS

Muestra un NAS de UniFi en Drive con sus pools, bahías y copias. En Drive, en
**Ubicaciones**, elige **Añadir conexión > UniFi UNAS** (detectar un NAS por IP
encuentra uno en tu red). Usa una cuenta local de la consola, no un inicio de
sesión SSO de Ubiquiti con 2FA.

## Docker

Vigila y gestiona los contenedores de un engine de Docker. El host local
aparece solo en la edición completa. Para otro engine, abre **Contenedores** y
elige **Añadir host**, y luego un transporte: Socket local, SSH (Engine del
host) con usuario y clave privada, o TCP con certificados TLS opcionales.

## Vercel, Railway y AWS

Pone los servicios que tienes allí en el tablero de un proyecto, con lo último
que publicó cada uno y un botón para publicarlo de nuevo. Ellos siguen
construyéndolo y sirviéndolo. En **Cuenta > Cuentas conectadas**, elige **Usar
un token**:

- Vercel: un token de cuenta con acceso al equipo donde están los proyectos.
- Railway: un token de cuenta, que llega a todos los workspaces; un token de
  proyecto no puede listar el resto.
- AWS: un access key ID, su secreto y la región donde están tus servicios de
  ECS y ramas de Amplify. Solo lectura basta para vigilar; publicar de nuevo
  necesita ecs:UpdateService o amplify:StartJob.

Después, en la sección **Externos** de un proyecto, elige **Añadir servicio**.

## GitHub Copilot

Copilot CLI se ejecuta en las sesiones de agente ya conectado con el token de
GitHub de la sesión, así que no hay que vincular nada. Copilot como cliente MCP
se conecta desde **Cuenta > Asistentes de IA**.

## Bitwarden, Vaultwarden y KeePassXC

Vault habla el protocolo de Bitwarden, así que sus apps y extensiones funcionan
con él como con un servidor Vaultwarden. Abre **Vault > Conectar una app**,
copia **Dirección del servidor** y, en la pantalla de inicio de sesión de la app,
elige Self-hosted y pégala en Server URL. Entra con tu email de Polaris y tu
contraseña maestra.

Para traer contraseñas, usa **Importar** en **Vault > Ajustes**: un export JSON
de Bitwarden, un export XML de KeePass (KeePass y KeePassXC: File > Export) o un
CSV. Una base .kdbx no es un export.

## Obsidian

En Notas, elige **Importar Markdown** en un cuaderno y escoge archivos, una
carpeta o un vault comprimido. Los enlaces escritos como [[otra nota]] se
conectan cuando todo está dentro.

## PostgreSQL, MySQL, MariaDB, MongoDB y Redis

Las bases de datos que Polaris ejecuta para tus servicios aparecen solas en
**Bases de datos**. Para cualquier otra, elige **Nueva conexión**, el motor y
rellena los campos, o pega una **URL de conexión** y pulsa **Importar**. Puede
pasar por uno de tus servidores, usar SSL eligiendo cuánto se comprueba el
certificado, y ser de **Solo lectura**.
