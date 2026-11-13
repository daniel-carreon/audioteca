// Lectura de la carpeta de libros (`AUDIOTECA_LIBROS/<slug>/`) según docs/FORMATO.md (varias voces por libro).
// Solo lectura. Tolera libros a medio escribir: carpetas sin libro.json, JSON truncado mientras el narrador
// lo reescribe, capítulos con texto pero sin audio, estados desconocidos.
//
// Narraciones: `audio/<voz>/NN.mp3|json` (v2) y, por compatibilidad, `audio/NN.mp3|json` (v1), que cuenta
// como la voz que diga su json. Cada capítulo lleva todas sus narraciones; los campos planos (audio,
// duracion, bytes, v, voz) son la narración que suena por omisión: la voz del libro o, si esa aún no llega
// a ese capítulo, la primera otra voz que lo tenga.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { alinearCapitulo } from './alinear.mjs'

export const SLUG = /^[a-z0-9][a-z0-9-]{0,120}$/
export const NN = /^\d{2,3}$/
export const VOZ = /^[a-z0-9][a-z0-9-]{0,60}$/
export const VOZ_DEFECTO = 'macos'

const cacheJson = new Map() // ruta → { mtimeMs, size, valor }

function stat(ruta) {
  try { return statSync(ruta) } catch { return null }
}

export function leerJson(ruta) {
  const st = stat(ruta)
  if (!st) return null
  const previo = cacheJson.get(ruta)
  if (previo && previo.mtimeMs === st.mtimeMs && previo.size === st.size) return previo.valor
  try {
    const valor = JSON.parse(readFileSync(ruta, 'utf8'))
    cacheJson.set(ruta, { mtimeMs: st.mtimeMs, size: st.size, valor })
    return valor
  } catch {
    // Escritura a medias del narrador: se usa la última versión buena si la hay.
    return previo?.valor ?? null
  }
}

const nn = (n) => String(n).padStart(2, '0')
const vozValida = (v, def) => (typeof v === 'string' && VOZ.test(v) ? v : def)

/** Todas las narraciones del libro: Map voz → Map n → { mp3, json, stMp3, stJson }. */
function narraciones(dir, vozLibro) {
  const out = new Map()
  const poner = (voz, n, mp3, json) => {
    const stMp3 = stat(mp3)
    const stJson = stat(json)
    if (!stMp3 || !stMp3.size || !stJson) return
    if (!out.has(voz)) out.set(voz, new Map())
    if (!out.get(voz).has(n)) out.get(voz).set(n, { mp3, json, stMp3, stJson })
  }
  const audio = join(dir, 'audio')
  let entradas = []
  try { entradas = readdirSync(audio, { withFileTypes: true }) } catch { return out }
  // v2 primero: si un capítulo existe en las dos formas, gana la carpeta de la voz.
  for (const d of entradas) {
    if (!d.isDirectory() || !VOZ.test(d.name)) continue
    let archivos = []
    try { archivos = readdirSync(join(audio, d.name)) } catch { continue }
    for (const f of archivos) {
      const m = /^(\d{2,3})\.mp3$/.exec(f)
      if (m) poner(d.name, Number(m[1]), join(audio, d.name, f), join(audio, d.name, `${m[1]}.json`))
    }
  }
  for (const d of entradas) {
    const m = d.isFile() && /^(\d{2,3})\.mp3$/.exec(d.name)
    if (!m) continue
    const json = join(audio, `${m[1]}.json`)
    poner(vozValida(leerJson(json)?.voz, vozLibro), Number(m[1]), join(audio, d.name), json)
  }
  return out
}

function duracionDe(c, narr) {
  const s = leerJson(narr.json)
  const d = Number(s?.duracion_s) || (Array.isArray(s?.segmentos) && s.segmentos.length ? Number(s.segmentos[s.segmentos.length - 1].fin) || 0 : 0)
  return Math.round((d || Number(c.duracion_s) || 0) * 100) / 100
}

/** Ficha pública de un libro (lo que el teléfono necesita; nunca rutas del disco). */
// La de «portada» en libro.json; si no la nombra, `portada.jpg` de la carpeta (la que se deja antes de que el
// traductor escriba libro.json, que conserva campos pero no la agrega).
export function archivoPortada(dir, meta) {
  const nombre = meta.portada === undefined ? 'portada.jpg' : meta.portada
  return typeof nombre === 'string' && /^[\w.-]+\.(jpe?g|png|webp)$/i.test(nombre) && existsSync(join(dir, nombre)) ? nombre : null
}

export function leerLibro(raiz, slug) {
  if (!SLUG.test(slug)) return null
  const dir = join(raiz, slug)
  const meta = leerJson(join(dir, 'libro.json'))
  if (!meta || typeof meta !== 'object') return null
  const voz = vozValida(meta.voz, VOZ_DEFECTO)
  const porVoz = narraciones(dir, voz)
  // Orden de preferencia: la voz del libro y luego las que más capítulos tienen.
  const voces = [...porVoz.keys()].sort((a, b) => (a === voz ? -1 : b === voz ? 1 : porVoz.get(b).size - porVoz.get(a).size || a.localeCompare(b)))
  const caps = Array.isArray(meta.capitulos) ? meta.capitulos.filter((c) => Number.isInteger(Number(c?.n)) && Number(c.n) > 0) : []
  const capitulos = caps.map((c) => {
    const n = Number(c.n)
    const archivoTexto = typeof c.archivo_texto === 'string' ? c.archivo_texto : `texto/${nn(n)}.md`
    const conTexto = !!stat(join(dir, 'texto', `${nn(n)}.md`)) && /^texto\/\d{2,3}\.md$/.test(archivoTexto)
    const narr = {}
    for (const v of voces) {
      const x = porVoz.get(v).get(n)
      // Versión: cambia si el narrador rehace el capítulo, e invalida la descarga del teléfono.
      if (x) narr[v] = { d: duracionDe(c, x), b: x.stMp3.size, v: Math.round(Math.max(x.stMp3.mtimeMs, x.stJson.mtimeMs)).toString(36) }
    }
    const elegida = voces.find((v) => narr[v])
    const e = elegida ? narr[elegida] : null
    return {
      n,
      nn: nn(n),
      titulo: String(c.titulo || `Capítulo ${n}`),
      texto: conTexto,
      audio: !!e,
      duracion: e ? e.d : 0,
      bytes: e ? e.b : 0,
      v: e ? e.v : null,
      voz: elegida || null,
      narraciones: narr,
    }
  }).sort((a, b) => a.n - b.n)
  const portada = archivoPortada(dir, meta)
  const stPortada = portada ? stat(join(dir, portada)) : null
  return {
    slug,
    titulo: String(meta.titulo || slug),
    titulo_original: meta.titulo_original ? String(meta.titulo_original) : null,
    autor: String(meta.autor || ''),
    traducido: !!meta.traducido,
    idioma_original: meta.idioma_original ? String(meta.idioma_original) : null,
    voz,
    estado: String(meta.estado || 'pendiente'),
    nota: meta.nota ? String(meta.nota) : null,
    portada: portada ? `portada?v=${Math.round(stPortada.mtimeMs).toString(36)}` : null,
    glosario: typeof meta.glosario === 'string' && existsSync(join(dir, 'glosario.md')),
    capitulos,
    narrados: capitulos.filter((c) => c.audio).length,
    duracion: Math.round(capitulos.reduce((a, c) => a + c.duracion, 0)),
  }
}

export function listarLibros(raiz) {
  let nombres = []
  try { nombres = readdirSync(raiz, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch { return [] }
  return nombres
    .filter((s) => SLUG.test(s))
    .map((s) => leerLibro(raiz, s))
    .filter(Boolean)
}

/** Ruta del mp3 de un capítulo en una voz (o en la voz por omisión del capítulo si no se pide ninguna). */
export function rutaAudio(raiz, slug, n, voz = null) {
  const libro = leerLibro(raiz, slug)
  const cap = libro?.capitulos.find((c) => c.nn === n)
  const v = voz || cap?.voz
  if (!cap || !v || !cap.narraciones[v]) return null
  const dir = join(raiz, slug)
  return narraciones(dir, libro.voz).get(v)?.get(cap.n)?.mp3 || null
}

const cacheCapitulos = new Map()

/** Texto del capítulo alineado con los segmentos de una voz (cacheado por mtime de ambos archivos). */
export function leerCapitulo(raiz, slug, n, voz = null) {
  if (!SLUG.test(slug) || !NN.test(n) || (voz !== null && !VOZ.test(voz))) return null
  const dir = join(raiz, slug)
  const libro = leerLibro(raiz, slug)
  const cap = libro?.capitulos.find((c) => c.nn === n)
  if (!cap) return null
  const v = voz && cap.narraciones[voz] ? voz : cap.voz
  const narr = v ? narraciones(dir, libro.voz).get(v)?.get(cap.n) : null
  const rutaMd = join(dir, 'texto', `${n}.md`)
  const stMd = stat(rutaMd)
  const stSegs = narr ? stat(narr.json) : null
  const clave = `${slug}/${n}/${v}`
  const firma = `${stMd?.mtimeMs}:${stMd?.size}:${stSegs?.mtimeMs}:${stSegs?.size}`
  const previo = cacheCapitulos.get(clave)
  if (previo && previo.firma === firma) return previo.valor
  const md = stMd ? readFileSync(rutaMd, 'utf8') : `# ${cap.titulo}\n`
  const segmentos = narr ? (leerJson(narr.json)?.segmentos || []).filter((s) => s && typeof s.texto === 'string') : []
  const { titulo, bloques } = alinearCapitulo(md, segmentos)
  const e = v ? cap.narraciones[v] : null
  const valor = {
    slug,
    n: cap.n,
    nn: n,
    titulo: titulo || cap.titulo,
    audio: !!e,
    voz: e ? v : null,
    v: e ? e.v : null,
    duracion: e ? e.d : 0,
    bloques,
    segmentos: segmentos.map((s) => [Number(s.inicio) || 0, Number(s.fin) || 0]),
  }
  cacheCapitulos.set(clave, { firma, valor })
  return valor
}
