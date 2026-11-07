# Instala Polaris TV

[Read in English](polaris-tv-install.md) - [Volver al README](../../README.es.md)

Polaris TV se instala desde la app de escritorio de Polaris, en un ordenador de la misma red que la tele o
conectado a ella por cable USB. Los pasos son los mismos en todas las teles: lo que cambia según la marca
lo resuelve la app a partir de la tele que encuentra.

## 1. Pulsa Instalar

Abre la app de escritorio de Polaris, ve a Descargas > Polaris TV > Instalar en una tele y pulsa
**Instalar**. La app busca las teles de tu red, o usa la dirección de la tele (Ajustes > Red en la tele la
muestra), o la tele conectada en la pestaña de cable USB.

## 2. Activa la depuración, solo si la app lo pide

Si la depuración sigue desactivada, la app muestra una sola indicación para esa tele: sobre qué elemento
pulsar OK siete veces y qué interruptor activar en Opciones para desarrolladores. Hazlo en la tele. La app
lo detecta sola y continúa, así que no hay nada que reintentar.

## 3. Acepta en la tele

La tele pregunta "¿Permitir depuración USB?". Elige **Permitir**; si nadie responde, vuelve a preguntar.
La app guarda entonces una copia de los ajustes de la tele en el ordenador, instala Polaris TV y vuelve a
desactivar la depuración.

## Lo que la app decide por ti

- **Fire TV** (Fire OS 6 o posterior): Polaris TV es una app que abres, porque Amazon conserva el botón de
  inicio. La caja Fire TV de 2015 con Fire OS 5 no puede instalarla.
- **Huawei (HarmonyOS) y Kalley**: Polaris TV no se pone como pantalla de inicio. En una de cada, eso dejó
  la tele sin poder arrancar.
- **TCL**: la app permite que Polaris TV se inicie sola, algo que el firmware de TCL bloquea si no.
- **Anteriores a Android 8, o sin Android**: la app lo dice. Estas teles pueden igualmente
  [bloquear anuncios en toda la casa](polaris-tv-network.md).
- **Chromecast con Google TV y Google TV Streamer** solo activan la depuración con un código de
  emparejamiento de depuración inalámbrica, que la app aún no puede usar. Instala por cable USB si el
  dispositivo tiene puerto de datos, o bloquea anuncios en toda la casa.

Mira también: [¿Funciona en mi tele?](polaris-tv-compatibility.md) y los
[ajustes de privacidad por marca](polaris-tv-privacy.md).
