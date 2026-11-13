// Libro de prueba con la forma exacta de docs/FORMATO.md, narrado con `say` del sistema (gratis, local, determinista)
// en DOS voces: «lectora» (voz del libro, capítulos 1 y 2) y «lector» (solo el capítulo 1, más lento: los tiempos de
// cada oración difieren y así se prueba que cambiar de voz conserva la oración). El capítulo 3 queda sin narrar.
// Texto: fragmentos del Quijote (Cervantes, 1605; dominio público) en oraciones cortas. Así los tests y el e2e no dependen del narrador.
// Uso: node app/scripts/crear-fixture.mjs [--si-falta]  → app/fixtures/libros/prueba-audioteca/
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, renameSync, unlinkSync, rmdirSync, readdirSync, mkdtempSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..')
const destino = join(raiz, 'fixtures/libros/prueba-audioteca')
// Tiempos por palabra del libro de prueba (contrato de app/scripts/palabras/alinear.py): se reparten dentro de cada
// oración en proporción a las letras de cada palabra. Son de prueba (el alineador real usa un modelo y aquí no hace
// falta): sirven para que tests y e2e ejerzan el lector palabra a palabra sin descargar nada.
const destinoPalabras = join(destino, '../../palabras/prueba-audioteca')
if (process.argv.includes('--si-falta') && existsSync(join(destino, 'libro.json')) && existsSync(join(destinoPalabras, 'lectora', '01.json'))) process.exit(0)

/** Voces de `say` en español instaladas en este Mac (Paulina y Mónica vienen con macOS). */
function vocesSay() {
  const lista = execFileSync('say', ['-v', '?']).toString().split('\n')
  return lista.filter((l) => /\bes_(MX|US|419|ES)\b/.test(l)).map((l) => l.split(/\s{2,}/)[0].trim())
}
const disponibles = vocesSay()
const elegir = (...pref) => pref.find((v) => disponibles.includes(v)) || disponibles[0]
if (!disponibles.length) throw new Error('No hay voces de say en español: instala una en Ajustes del Sistema → Accesibilidad → Contenido leído')
const VOCES = [
  { id: 'lectora', say: elegir('Paulina', 'Mónica'), ritmo: 190, capitulos: [1, 2] },
  { id: 'lector', say: elegir('Juan', 'Jorge', 'Diego', 'Paulina'), ritmo: 150, capitulos: [1] },
]

const capitulos = [
  {
    titulo: 'La condición del hidalgo',
    parrafos: [
      'En un lugar de la Mancha vivía un hidalgo. Tenía lanza en astillero y adarga antigua. Tenía también un rocín flaco y un galgo corredor.',
      'Frisaba la edad de nuestro hidalgo con los cincuenta años. Era de complexión recia y seco de carnes. Era gran madrugador y amigo de la caza.',
      'Se enfrascó tanto en su lectura que pasaba las noches leyendo. ¿Quién duda que saldrá a luz la historia de mis hechos? Así hablaba consigo mismo.',
      'Del poco dormir y del mucho leer se le secó *el celebro*. Al fin vino a perder el juicio.',
    ],
  },
  {
    titulo: 'La primera salida',
    parrafos: [
      'Hechas, pues, estas prevenciones, no quiso aguardar más tiempo a poner en efecto su pensamiento.',
      'Una mañana, antes del día, se armó de todas sus armas y subió sobre Rocinante. Salió al campo con grandísimo contento.',
      '«Dichosa edad y siglo dichoso aquel adonde saldrán a luz las famosas hazañas mías». Eso iba diciendo.',
    ],
  },
  {
    titulo: 'Lo que queda por narrar',
    parrafos: ['Este capítulo todavía no tiene audio: la app debe dejarlo leer igual, sin reproductor.'],
  },
]

function oraciones(parrafo) {
  // Corta tras . ! ? … » cuando sigue espacio; suficiente para el texto de prueba.
  return parrafo.replace(/\*/g, '').match(/[^.!?…]+[.!?…]+[»"]?\s*|[^.!?…]+$/g).map((s) => s.trim()).filter(Boolean)
}

function duracion(archivo) {
  return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', archivo]).toString().trim())
}

// Igual que el alineador: tokens por espacios, solo letras, dígitos y apóstrofo.
const limpiar = (w) => [...w].filter((c) => c === "'" || /[\p{L}\p{N}]/u.test(c)).join('')
function escribirPalabras(voz, nn, json, bytesMp3, segmentos) {
  const porSeg = segmentos.map(({ texto, inicio, fin }) => {
    const ws = texto.split(/\s+/).map(limpiar).filter(Boolean)
    const total = ws.reduce((a, w) => a + w.length, 0) || 1
    let t = inicio
    return ws.map((w) => { const t0 = t; t += (fin - inicio) * w.length / total; return [w, +t0.toFixed(2), +t.toFixed(2)] })
  })
  const fuente = { json: createHash('sha1').update(json).digest('hex').slice(0, 16), mp3: bytesMp3 }
  mkdirSync(join(destinoPalabras, voz), { recursive: true })
  writeFileSync(join(destinoPalabras, voz, `${nn}.json`), JSON.stringify({ v: 1, modelo: 'fixture-proporcional', fuente, segmentos: porSeg }))
}

// Se sobrescribe archivo por archivo (sin borrados recursivos).
mkdirSync(join(destino, 'texto'), { recursive: true })
for (const v of VOCES) mkdirSync(join(destino, 'audio', v.id), { recursive: true })
const tmp = mkdtempSync(join(tmpdir(), 'audioteca-fixture-'))

const libro = {
  slug: 'prueba-audioteca', titulo: 'Don Quijote de prueba', autor: 'Miguel de Cervantes', idioma_original: 'es',
  traducido: false, fuente: 'fixture (dominio público)', voz: VOCES[0].id, estado: 'narrando', capitulos: [],
}

capitulos.forEach((cap, idx) => {
  const nn = String(idx + 1).padStart(2, '0')
  writeFileSync(join(destino, 'texto', `${nn}.md`), `# ${cap.titulo}\n\n${cap.parrafos.join('\n\n')}\n`)
  const entrada = { n: idx + 1, titulo: cap.titulo, archivo_texto: `texto/${nn}.md` }
  for (const voz of VOCES.filter((v) => v.capitulos.includes(idx + 1))) {
    const segmentos = []
    const piezas = []
    let t = 0
    oraciones([cap.titulo + '.', ...cap.parrafos].join(' ')).forEach((texto, i) => {
      const aiff = join(tmp, `${voz.id}-${nn}-${i}.aiff`)
      execFileSync('say', ['-v', voz.say, '-r', String(voz.ritmo), '-o', aiff, texto])
      const d = duracion(aiff)
      segmentos.push({ i, texto, inicio: +t.toFixed(2), fin: +(t + d).toFixed(2) })
      piezas.push(aiff)
      t += d
    })
    const lista = join(tmp, `${voz.id}-${nn}.txt`)
    writeFileSync(lista, piezas.map((p) => `file '${p}'`).join('\n'))
    const dir = join(destino, 'audio', voz.id)
    const mp3tmp = join(dir, `.${nn}.mp3.tmp`)
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', lista, '-ac', '1', '-b:a', '64k', '-f', 'mp3', mp3tmp])
    renameSync(mp3tmp, join(dir, `${nn}.mp3`))
    const json = JSON.stringify({ duracion_s: +t.toFixed(2), voz: voz.id, segmentos })
    writeFileSync(join(dir, `${nn}.json`), json)
    escribirPalabras(voz.id, nn, json, statSync(join(dir, `${nn}.mp3`)).size, segmentos)
    if (voz === VOCES[0]) Object.assign(entrada, { archivo_audio: `audio/${voz.id}/${nn}.mp3`, duracion_s: +t.toFixed(2) })
  }
  libro.capitulos.push(entrada)
})

writeFileSync(join(destino, 'libro.json'), JSON.stringify(libro, null, 2))
for (const f of readdirSync(tmp)) unlinkSync(join(tmp, f))
rmdirSync(tmp)
console.log('fixture lista:', destino, libro.capitulos.map((c) => `${c.n}:${c.duracion_s ?? 'texto'}`).join(' '))
