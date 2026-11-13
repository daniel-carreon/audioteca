// Valida la alineación por palabra de capítulos reales, de punta a punta (archivo de palabras → leerCapitulo):
//   node app/scripts/palabras/validar.mjs <slug> <voz> 1,2,3
// Por capítulo: cobertura (palabras pintables / tokens del texto narrado, ≥ 97 %), tiempos dentro de su
// segmento y no decrecientes, ritmo 1.5–8 palabras/s a 1×, y que el texto de cada [b, desde, hasta] sea la
// palabra alineada (normalizada, ≥ 99 %). Solo lee; sale con 1 si algo no pasa.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { leerCapitulo, rutaPalabras } from '../../server/libros.mjs'
import { normalizar } from '../../server/alinear.mjs'
import { entorno, ruta } from '../../server/config.mjs'

const env = entorno()
const libros = ruta(env.AUDIOTECA_LIBROS, 'biblioteca')
const datos = ruta(env.AUDIOTECA_DATOS, '.data')
const [slug, voz, caps = '1'] = process.argv.slice(2)
if (!slug || !voz) { console.error('uso: node scripts/palabras/validar.mjs <slug> <voz> [1,2,3]'); process.exit(2) }

// Igual que clean_token del aligner (letras, dígitos y apóstrofo), separado por espacios.
const tokens = (t) => String(t || '').split(/\s+/).map((w) => [...w].filter((c) => c === "'" || /[\p{L}\p{N}]/u.test(c)).join('')).filter(Boolean)

let ok = true
for (const n of caps.split(',').map((x) => String(Number(x)).padStart(2, '0'))) {
  const cap = leerCapitulo(libros, slug, n, voz, { datos })
  if (!cap) { console.log(`${n}: capítulo no encontrado`); ok = false; continue }
  const archivo = JSON.parse(readFileSync(rutaPalabras(datos, slug, voz, n), 'utf8'))
  const narr = JSON.parse(readFileSync(join(libros, slug, 'audio', voz, `${n}.json`), 'utf8')).segmentos
  const totalTokens = narr.reduce((a, s) => a + tokens(s.texto).length, 0)
  const alineadas = archivo.segmentos.flat()

  // Tiempos: dentro de su segmento y no decrecientes en todo el capítulo.
  let fuera = 0, retrocesos = 0, prev = 0
  archivo.segmentos.forEach((ws, i) => {
    for (const [, t0, t1] of ws) {
      if (t0 < narr[i].inicio - 1e-6 || t1 > narr[i].fin + 1e-6) fuera++
      if (t0 < prev - 1e-6 || t1 < t0) retrocesos++
      prev = t1
    }
  })
  const dur = cap.duracion || narr[narr.length - 1].fin
  const ritmo = alineadas.length / dur

  // Texto pintado de cada palabra del API ↔ la palabra alineada (el API es una subsecuencia en orden).
  const textoBloque = cap.bloques.map((b) => b.tramos.map((t) => t[0]).join(''))
  let j = 0, casan = 0, noCasan = []
  for (const [w, t0, t1] of alineadas) {
    const p = cap.palabras[j]
    if (!p || p[0] !== t0 || p[1] !== Math.max(t0, t1)) continue
    const pintado = textoBloque[p[2]].slice(p[3], p[4])
    if (normalizar(pintado) === normalizar(w)) casan++
    else if (noCasan.length < 5) noCasan.push(`«${w}»→«${pintado}»`)
    j++
  }
  const ordenado = cap.palabras.every((p, k) => k === 0 || p[0] >= cap.palabras[k - 1][0])
  // Lo que suena después está después en el texto: un salto atrás delataría una palabra puesta en otro sitio.
  const atras = cap.palabras.filter((p, k) => k > 0 && (p[2] < cap.palabras[k - 1][2] || (p[2] === cap.palabras[k - 1][2] && p[3] < cap.palabras[k - 1][4]))).length
  const cobertura = cap.palabras.length / totalTokens
  const mapeo = cap.palabras.length ? casan / cap.palabras.length : 0
  const pasa = cobertura >= 0.97 && mapeo >= 0.99 && j === cap.palabras.length && !fuera && !retrocesos && ordenado && !atras && ritmo >= 1.5 && ritmo <= 8
  ok &&= pasa
  console.log(
    `${pasa ? '✓' : '✗'} ${slug}/${voz}/${n}: ${totalTokens} tokens, ${alineadas.length} alineadas, ${cap.palabras.length} pintables ` +
    `(cobertura ${(cobertura * 100).toFixed(2)} %), mapeo ${(mapeo * 100).toFixed(2)} % (${casan}/${cap.palabras.length}` +
    `${j !== cap.palabras.length ? `, ${cap.palabras.length - j} sin pareja` : ''}), fuera de segmento ${fuera}, retrocesos ${retrocesos}, saltos atrás en el texto ${atras}, ` +
    `ritmo ${ritmo.toFixed(2)} palabras/s en ${(dur / 60).toFixed(1)} min${noCasan.length ? ` · ej. ${noCasan.join(' ')}` : ''}`,
  )
}
process.exit(ok ? 0 : 1)
