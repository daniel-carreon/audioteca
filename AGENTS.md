# Audioteca · notas para quien contribuya (personas o agentes)

- Lee primero `README.md` (uso) y `docs/FORMATO.md` (la interfaz entre piezas: nadie más que el narrador
  escribe `audio/`, nadie más que el extractor/traductor escribe `texto/`, la app solo lee y escribe `pedidos.json`).
- Configuración: siempre por `.env` (`app/server/config.mjs` y `pipeline/config.py` leen lo mismo). Nada de rutas
  absolutas, correos, dominios ni llaves en el código: `tests/python/test_marca_blanca.py` lo vigila.
- Escrituras atómicas (tmp → rename) y `libro.json` con candado (`.libro.lock`). Sin borrados recursivos.
- Antes de entregar: `./audioteca check` (Node unit + Python + e2e WebKit). Si cambias `app/public/sw.js` en sí,
  sube su `VERSION`; el resto del shell se sella solo con hash de contenido.
- Lector palabra a palabra: `app/public/js/lector-palabras.js` (cliente), `app/scripts/palabras/alinear.py` (tiempos
  en `<datos>/palabras/<slug>/<voz>/NN.json`; `fuente` = sha1 del NN.json + bytes del mp3, distinta = vieja). El
  fixture escribe tiempos de prueba proporcionales: no hace falta el modelo para las pruebas.
- Las pruebas nunca suenan: el e2e silencia todo `<audio>` y `speechSynthesis`; no quites eso.
- Íconos y splash: `node app/scripts/iconos.mjs` (la paleta vive en `:root` de `app/public/app.css`).
