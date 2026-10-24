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
