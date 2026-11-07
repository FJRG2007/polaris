# Configura una tele Android o Google TV en tres pasos

[Read in English](polaris-tv-setup.md) - [Volver al README](../../README.es.md)

Polaris TV se instala desde la app de escritorio de Polaris, en un ordenador de la misma red que la tele o
conectado a ella por cable USB. En el ordenador no se escribe nada más que la dirección de la tele.

## 1. Activa la depuración en la tele

1. Abre Ajustes > Preferencias del dispositivo > Información (Sistema > Información en algunas) y pulsa OK
   sobre **Compilación** siete veces, hasta que la tele diga que eres desarrollador.
2. De vuelta en Preferencias del dispositivo (o Sistema), abre **Opciones para desarrolladores** y activa
   la **Depuración por USB**.
3. Para instalar por la red, activa también la **Depuración por red** o la **Depuración inalámbrica**,
   según la que tenga la tele.

## 2. Instala desde la app de escritorio

Abre la app de escritorio de Polaris y ve a Descargas > Polaris TV > Instalar en una tele. Busca las teles
de tu red, o acepta la dirección de la tele (Ajustes > Red en la tele la muestra). Deja activado "Ponerla
como pantalla de inicio" para sustituir el inicio de la tele; el suyo sigue instalado.

## 3. Acepta en la tele

La tele pregunta "¿Permitir depuración por USB?". Acéptalo. La app de escritorio guarda una copia de los
ajustes de la tele en el ordenador, instala Polaris TV y, al terminar, vuelve a desactivar la depuración
por red.

## Teles que necesitan un paso más

- **Chromecast con Google TV y Google TV Streamer** mantienen cerrado el puerto de depuración habitual.
  Activa la **Depuración inalámbrica** y vincúlala con el código que muestra la tele. Se cierra en cada
  reinicio.
- Las teles **TCL** pueden impedir que un launcher arranque solo. La app de escritorio lo permite al
  instalar.
- **Huawei (HarmonyOS) y la Kalley 43G200**: deja desactivado "Ponerla como pantalla de inicio". En una de
  cada, el cambio dejó la tele sin arrancar.

Ver también: [¿Funciona en mi tele?](polaris-tv-compatibility.md) y los
[ajustes de privacidad por marca](polaris-tv-privacy.md).
