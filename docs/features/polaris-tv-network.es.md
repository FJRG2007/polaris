# Bloquea anuncios en cualquier tele

[Read in English](polaris-tv-network.md) - [Volver al README](../../README.es.md)

Las teles Roku, Vizio, Hisense VIDAA, LG y Samsung todavía no pueden usar Polaris TV, y algunas nunca
podrán. Aun así buscan cada anuncio y rastreador por su nombre, así que el Filtro de red puede negar esos
nombres a todas las teles de casa.

## Usa el Filtro de red como DNS del router

Abre **Filtro de red** en Polaris. Su guía del router da la dirección que hay que escribir y dónde suele
estar el ajuste en tu router. Cuando el router reparte esa dirección, todos los dispositivos de la red usan
el filtro, teles incluidas.

## Evita que la tele lo esquive

- Muchas teles preguntan a un servidor DNS fijo en lugar del router. Si tu router lo permite, envía el
  tráfico saliente del puerto 53 al filtro y bloquea el puerto 853 saliente para que la tele no pase a DNS
  cifrado en otro sitio.
- No bloquees los dominios de actualización de la tele: una tele que no se actualiza deja de recibir
  parches de seguridad.
- Vuelve a comprobarlo tras cada actualización de firmware. Pueden traer dominios de rastreo nuevos o
  reactivar ajustes de privacidad.

Después desactiva lo que la tele recoge en sus propios menús:
[ajustes de privacidad por marca](polaris-tv-privacy.md).
