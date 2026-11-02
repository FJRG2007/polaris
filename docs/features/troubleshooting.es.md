# Cuando no se puede acceder a Polaris

[Read in English](troubleshooting.md) - [Volver al README](../../README.es.md)

Qué comprobar cuando una pantalla dice que no se puede acceder a Polaris, en el orden
que encuentra la causa más rápido. Nada de esto necesita una terminal.

## Averigua hasta dónde llega

Abre Polaris en un móvil con datos, con el Wi-Fi apagado.

| Qué ves | Qué significa | Ve a |
| --- | --- | --- |
| Carga en el móvil, en este dispositivo no | Polaris funciona; el problema es este dispositivo o su red | [Solo este dispositivo](#solo-este-dispositivo) |
| No carga en ninguno | La máquina de Polaris está apagada o perdió la red | [Todos los dispositivos](#todos-los-dispositivos) |
| Carga en casa pero no desde fuera | La máquina está bien; falla la entrada desde internet | [Solo desde fuera](#solo-desde-fuera) |

## Solo este dispositivo

- Abre cualquier otra web. Si no carga nada, este dispositivo no tiene internet y
  Polaris no es el problema.
- Si acabas de cambiar un router, puede que siga con su dirección antigua.
  Desconecta su cable de red o apaga y enciende el Wi-Fi.
- Si usas una VPN en este dispositivo, apágala y vuelve a probar.
- En la app de escritorio, usa otra dirección del mismo Polaris desde la ventana de
  servidores. En un navegador, la página ofrece tu dirección local cuando puede
  demostrar que es el mismo Polaris.

## Todos los dispositivos

- Comprueba que la máquina está encendida y que la luz de su puerto de red está
  encendida.
- Comprueba el switch o router donde está conectada, y prueba otro puerto y otro
  cable.
- Abre la lista de dispositivos conectados de tu router. Si la máquina no aparece,
  no está en tu red: la causa es el cable, el puerto o la máquina.
- Si aparece con otra dirección distinta, su red ha cambiado. Mira
  [Después de cambiar un router](#despues-de-cambiar-un-router).

## Después de cambiar un router

Dos routers seguidos crean dos redes. Un dispositivo conserva su dirección hasta que
pide otra, y uno que sigue conectado puede no pedirla, así que acaba en una red donde
nada puede alcanzarlo.

- Vuelve a conectar la máquina al router donde estaba, o a un switch de ese router.
- Si quieres una sola red, pon el segundo router en modo punto de acceso y aplica el
  cambio. El cable que viene del primer router suele tener que ir a un puerto LAN, no
  al WAN. Si no, los dispositivos conectados a él no reciben dirección ni internet.
- Si ese modo te deja sin internet y no ves por qué, vuelve al modo router. Polaris
  no necesita el modo punto de acceso.
- Después de cualquier cambio, vuelve a conectar los dispositivos de ese router para
  que reciban una dirección nueva.

## Solo desde fuera

- Comprueba la conexión en la pantalla donde Polaris muestra sus dominios. Te dice
  si la dirección responde desde aquí.
- Con un relay, la máquina necesita internet para mantener su lado del túnel. Si
  perdió la red, el relay sigue en marcha y la web no carga.
- Una regla de tu router o un registro DNS te corresponde a ti. La pantalla del
  dominio indica los valores que hay que escribir.

## La app de escritorio se quedó en esta pantalla

Cuando el Polaris en uso deja de responder, la app de escritorio abre al lado la
ventana de servidores para que puedas abrir otro. Tus otros servidores siguen ahí y
cada uno se abre como siempre.

## Un juego en una llamada

Compartir un juego en pantalla completa exclusiva suele verse negro o congelado,
porque la captura no puede leerlo. Pon el juego en modo ventana sin bordes.

## La velocidad se queda en 94 o 95 Mbps

Eso es un enlace de 100 Mbit: 100 Mbit menos las cabeceras de red dan 94 a 95 Mbps.
Tu internet no es el límite. Alguna parte del camino se conecta a 100 en vez de a
1000.

- Mira la velocidad del puerto en el router o switch. La mayoría muestra 100 o 1000
  en cada puerto.
- Un enlace gigabit usa los ocho hilos del cable. Con un par dañado o un conector
  mal hecho, baja a 100. Las tiradas largas y los conectores hechos a mano son la
  causa habitual.
- Cambia una pieza cada vez: un cable corto, otro puerto y luego la tirada larga.
- Un switch o router antiguo con puertos 10/100 limita todo lo que pasa por él.
