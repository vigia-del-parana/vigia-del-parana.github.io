# Vigía del Paraná

App comunitaria, gratuita y sin fines de lucro para seguir la crecida de los ríos Paraná y Paraguay en Argentina y saber **cómo prepararse con tiempo** según tu ubicación. Pensada para que la use cualquier persona desde el celular, sin cuenta ni instalación.

**No es una aplicación oficial.** Reúne y ordena información publicada por organismos oficiales. Ante una emergencia, manda lo que indiquen Defensa Civil (103) y cada municipio.

## Qué hace

- Detecta tu zona por GPS, marcando tu casa en el mapa, escribiendo tu dirección o pegando lo que te da Google Maps.
- Muestra la altura actual del puerto más cercano, el ritmo de subida, los niveles oficiales de alerta y evacuación, y un estado en cuatro niveles: **Normal, Atención, Preparación, Salida**.
- Tiene **zonas finas** en distintas ciudades de la cuenca, con umbrales propios armados a partir de lo que pasó en crecidas anteriores (dentro o fuera de las defensas, costa o ciudad alta, lado río o lado laguna):
  - **Gran Santa Fe**: Colastiné Norte y Sur, La Guardia, Alto Verde, Arroyo Leyes, Santa Fe ciudad, Santo Tomé y Sauce Viejo, Coronda, Santa Rosa de Calchines, Cayastá y Helvecia, entre otras.
  - **Paraná**: Bajada Grande, costanera baja, Puerto Sánchez, Toma Nueva y ciudad alta.
  - **Corrientes, Barranqueras/Resistencia e Isla del Cerrito, Reconquista, Goya, Itatí y Paso de la Patria.**
- En el resto de la cuenca usa el puerto más cercano **de la misma orilla del río**, con los niveles oficiales.
- Incluye la **Proyección Vigía**: una estimación propia, con su banda de error, de cómo puede seguir el río según lo que viene pasando aguas arriba. No es un pronóstico oficial; cuando el INA publica el suyo, manda el del INA.
- Explica cómo prepararse según el nivel, qué pasa aguas arriba, el estado de Itaipú y Yacyretá, el pronóstico del INA y noticias de la cuenca con enlace a la fuente.
- Se instala como app (PWA) y abre sin conexión con los últimos datos vistos.

## De dónde salen los datos

| Dato | Fuente |
|---|---|
| Alturas diarias de 33 puertos, niveles de alerta y evacuación | [INA, Alerta Hidrológico Cuenca del Plata](https://alerta.ina.gob.ar/a5/diario/reporte_diario) (API `getObservaciones`), escalas de [Prefectura Naval Argentina](https://contenidosweb.prefecturanaval.gob.ar/alturas/) |
| Pronósticos (tramo medio: martes a 7 y 14 días, viernes a 4 y 11) | [INA](https://www.ina.gob.ar/alerta/) |
| Represas | [Entidad Binacional Yacyretá](https://www.eby.gov.py), [Itaipú Binacional](https://www.itaipu.gov.py) |
| Clima | [Servicio Meteorológico Nacional](https://www.smn.gob.ar) |
| Noticias | Medios de la región, resumidas con enlace a la nota original |

## Cómo se actualiza

- `data/alturas.json`: un GitHub Action (`.github/workflows/alturas.yml`) descarga las alturas del INA cada hora; solo publica cuando hay datos nuevos.
- `data/contexto.json`: resumen del día, represas, pronósticos y noticias. Lo actualiza una tarea programada que revisa las fuentes y publica al repositorio dos veces por día (07:45 y 19:45, hora Argentina).
- `data/estaciones.json`: catálogo de estaciones (fijo).
- `data/modelo.json`: parámetros de la Proyección Vigía. Un GitHub Action (`.github/workflows/modelo.yml`) los recalibra cada lunes con los últimos tres años de datos del INA.
- `data/zonas.geojson`: zonas finas de las ciudades de la cuenca. **Los polígonos son aproximados**; se ajustan en [geojson.io](https://geojson.io) con conocimiento local. Las zonas armadas con registros públicos (municipios, INA, prensa) están marcadas como estimadas hasta que vecinos las validen.

## Cómo se calcula el estado

- Para las zonas finas, cada zona tiene tres umbrales en la regla de su puerto de referencia (atención, preparación, salida), definidos con las crecidas anteriores y el estado de las defensas.
- Para el resto de las ciudades: atención = alerta oficial − 1 m, preparación = alerta − 0,5 m, salida = alerta oficial. La evacuación oficial se muestra siempre.
- La **Proyección Vigía** estima cuánto va a subir o bajar tu puerto en los próximos 1 a 15 días según cuánto subió o bajó el río en las últimas dos semanas en los puertos de aguas arriba que mejor lo explican (incluido el río Paraguay donde corresponde). Tiene pesos propios para cada horizonte, así capta que una crecida grande llega lenta y estirada por el valle. La banda de error es el error real del método al probarlo contra datos que no usó para ajustarse, y en crecida se usa el error medido en crecidas. Si el pronóstico del INA queda fuera de esa banda, la app lo avisa y manda el del INA. Donde no hay un modelo que funcione mejor que suponer que el río no cambia, se muestra solo la tendencia de la última semana. Ninguna de las dos es pronóstico oficial.

## Limitaciones

- El dato de altura es el diario de las 00 h; no es tiempo real.
- Hay zonas finas solo en las ciudades con registros públicos de crecidas anteriores. En las demás el estado es por ciudad, con los niveles oficiales. Ciudades como Bella Vista, Esquina, La Paz o Diamante no tienen zonas finas por falta de datos.
- Los links cortos de Google Maps (`maps.app.goo.gl`) no traen la ubicación. La app pide usar el GPS, el mapa o la dirección. Opcional: configurar `RESOLVER_URL` en `app.js` apuntando a un servicio que resuelva esos links.
- Lo que no está en la app: el río Salado, el río Uruguay, y la situación cuadra por cuadra.

## Colaborar

Correcciones de zonas, umbrales, referencias o textos: abrí un issue o un pull request. Si vivís en la Costa santafesina o en los barrios ribereños de Paraná y conocés hasta dónde llegó el agua en crecidas anteriores, ese dato vale más que cualquier estimación. Las zonas de Paraná se armaron con registros públicos (municipio, INA, prensa) y están marcadas como estimadas hasta que un vecino las valide.

## Licencia

[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) (ver [LICENSE](LICENSE)). El código es público para que cualquiera pueda ver y verificar cómo funciona la app. Vecinales, escuelas, universidades, organismos públicos y cualquier persona pueden usarlo, estudiarlo y adaptarlo sin fines de lucro, manteniendo el aviso de autoría. **No se permite el uso comercial.** Las versiones publicadas hasta el 16 de octubre de 2026 se distribuyeron bajo licencia MIT.

Los datos hidrométricos son del INA y de Prefectura Naval Argentina, y se rigen por las condiciones de esas fuentes.

Required Notice: Copyright (c) 2026 Melisa Franzotti — Vigía del Paraná

Hecho en Santa Fe, Argentina.
