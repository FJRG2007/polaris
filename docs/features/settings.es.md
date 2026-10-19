# Ajustes

[Read in English](settings.md) - [Volver al README](../../README.es.md)

Dos tipos de ajustes: los del despliegue, para quien administra Polaris, y los
de la cuenta de cada persona.

Cada imagen es la interfaz real dibujada con personas y datos inventados, y
sigue tu ajuste claro u oscuro. Las versiones para móvil están en
[docs/assets/media](../assets/media).

## El despliegue

<picture>
  <source media="(prefers-color-scheme: light)" srcset="../assets/media/settings-light-es-desktop.webp">
  <img src="../assets/media/settings-dark-es-desktop.webp" alt="Los ajustes del despliegue con una actualización lista para instalar">
</picture>

Las actualizaciones se instalan con el botón Actualizar, en el horario que
elijas o en cuanto se publican - desde la versión publicada o compiladas en
este host. La página muestra dónde se llega a Polaris, sus páginas públicas
para proveedores OAuth, los temas de temporada y una forma de llevarlo todo a
otra máquina en un archivo sellado con frase de paso.

## Personas y acceso

<picture>
  <source media="(prefers-color-scheme: light)" srcset="../assets/media/settings-users-light-es-desktop.webp">
  <img src="../assets/media/settings-users-dark-es-desktop.webp" alt="Cada cuenta con sus roles, límites y verificación en dos pasos, y las invitaciones pendientes">
</picture>

Todas las cuentas en una lista: sus roles, si es administradora, si está
limitada a algunos países o redes, suspendida o con verificación en dos pasos,
y cuándo y desde dónde se vio por última vez. Encima, las invitaciones que
siguen pendientes, y cada fila abre la ficha de la cuenta.

## Roles y permisos

<picture>
  <source media="(prefers-color-scheme: light)" srcset="../assets/media/settings-roles-light-es-desktop.webp">
  <img src="../assets/media/settings-roles-dark-es-desktop.webp" alt="Los permisos del rol member, marcados aplicación por aplicación">
</picture>

Cada persona tiene un rol, y un rol es una lista de permisos, aplicación por
aplicación: quién puede borrar archivos, montar un servidor de correo, dar op
a jugadores en un servidor de juegos o cambiar los ajustes de la instancia.
Los roles predefinidos (admin, member, viewer, guest) se pueden reescribir,
se pueden crear otros, y "Ver como" muestra Polaris tal como lo ve alguien con
ese rol. Una aplicación que un rol no puede usar ni siquiera aparece.

## Tu cuenta

<picture>
  <source media="(prefers-color-scheme: light)" srcset="../assets/media/account-security-light-es-desktop.webp">
  <img src="../assets/media/account-security-dark-es-desktop.webp" alt="Seguridad de la cuenta: contraseña, métodos de doble factor, PIN y límites de sesión">
</picture>

Cómo demuestras que eres tú y cuánto dura una sesión: contraseña, app de
autenticación, códigos por correo o WhatsApp, passkeys, códigos de respaldo, un
PIN de desbloqueo rápido, dispositivos de confianza, inicio de sesión con una
cuenta conectada, bloqueo por inactividad y límites de sesión, y un sucesor
para tus organizaciones. La cuenta también tiene su perfil, privacidad,
notificaciones, sesiones, claves de API y los asistentes de IA que pueden
actuar por ti.

## Todo lo demás también se configura

El chat tiene [reglas para toda la instancia](chat.es.md#reglas-para-toda-la-instancia),
[ajustes por canal](chat.es.md#ajustes-del-canal) y
[tu privacidad](chat.es.md#tu-privacidad); el correo tiene
[sus propios ajustes](mail.es.md#ajustes).
