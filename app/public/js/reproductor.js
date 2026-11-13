// Motor del reproductor: UN solo <audio> para toda la vida de la app (iOS solo deja sonar en segundo plano
// y encadenar capítulos al elemento que el usuario activó con un toque). Posición y velocidad por libro,
// Media Session para la pantalla bloqueada, avance automático, temporizador de sueño y voz por libro.
// Latencia: el audio arranca sin esperar al texto alineado (llega en paralelo), y antes de que acabe un
// capítulo se refresca la ficha y se precargan el texto y el arranque del audio del siguiente.
import { api, rutas } from './api.js'
import { estadoDescargas, vozDescargada } from './descargas.js'
import { arteParaPantallaBloqueada } from './portadas.js'
import { guardarProgreso, guardarPref, progreso, velocidadDe, vozDe, sincronizarPendientes, VEL_MIN, VEL_MAX } from './estado.js'
import { conVoz, tiempoEquivalente, segmentoEn as segmentoEnTiempo, nombreVoz } from './voces.js'
import { avisar, nn } from './util.js'

const audio = document.getElementById('audio')
const bus = new EventTarget()
const emitir = (tipo, detalle) => bus.dispatchEvent(new CustomEvent(tipo, { detail: detalle }))

export const estado = {
  libro: null, // ficha completa, vista con la voz elegida (conVoz)
  cap: null, // { n, nn, titulo, voz, v, segmentos, bloques, ... }
  segmento: -1,
  sueño: null, // { fin: ms } | { finCapitulo: true }
}

export const on = (tipo, fn) => { bus.addEventListener(tipo, fn); return () => bus.removeEventListener(tipo, fn) }
export const elemento = audio

const SALTO_ATRAS = 15
const SALTO_ADELANTE = 30

// ── Carga ────────────────────────────────────────────────────────────────
let busquedaPendiente = null
let velocidadActual = 1

function aplicarVelocidad() {
  audio.defaultPlaybackRate = velocidadActual
  audio.playbackRate = velocidadActual
  // Conservar el tono: voz natural, sin efecto ardilla.
  audio.preservesPitch = true
  audio.webkitPreservesPitch = true
  audio.mozPreservesPitch = true
}

async function fichaDe(slug, voz) {
  const ficha = await api.libro(slug).catch((e) => { if (estado.ficha?.slug === slug) return estado.ficha; throw e })
  return { ficha, libro: conVoz(ficha, voz === undefined ? vozDe(slug) : voz) }
}

/** Carga un capítulo. Si no se pasa `t`, retoma donde iba ese libro. `voz` cambia la voz elegida del libro. */
export async function cargar(slug, n, { t = null, reproducir = false, voz = undefined } = {}) {
  const { ficha, libro } = await fichaDe(slug, voz)
  const cap = libro.capitulos.find((c) => c.n === Number(n))
  if (!cap) throw new Error('Ese capítulo no existe')
  if (!cap.audio) throw new Error('Este capítulo aún no está narrado')
  // Sin red, si esa voz no está descargada pero otra sí, suena la descargada.
  const vozCap = (!navigator.onLine && (await vozDescargada(slug, cap))) || cap.voz
  const narr = cap.narraciones[vozCap]
  const p = progreso(slug)
  let inicio = t ?? (p && p.cap === cap.n ? p.t : 0)
  // El minuto guardado se midió en una voz: con otra, ese segundo cae en otra oración (al cambiar la voz por
  // omisión, un capítulo llegó a retomar 13 oraciones atrás). Se arranca ya en la
  // proporción de las duraciones (sin perder el toque que iOS exige para sonar) y, en cuanto llegan los dos textos,
  // se corrige a la MISMA oración, como al cambiar de voz a mano.
  let corregir = null
  if (t === null && inicio > 0.5) {
    const vozT = vozDelTiempo(p, ficha)
    const viejo = vozT !== vozCap ? cap.narraciones[vozT] : null
    if (viejo) {
      corregir = { voz: vozT, v: viejo.v, t: inicio }
      if (viejo.d > 0 && narr.d > 0) inicio = Math.min(narr.d - 1, (inicio * narr.d) / viejo.d)
    }
  }
  const mismo = estado.libro?.slug === slug && estado.cap?.n === cap.n && estado.cap?.voz === vozCap && audio.src
  // El texto alineado se pide ya, pero el audio no lo espera.
  const datos = api.capitulo(slug, cap.n, vozCap, narr.v)
  estado.ficha = ficha
  estado.libro = libro
  estado.cap = { n: cap.n, nn: cap.nn, titulo: cap.titulo, segmentos: [], bloques: [], voz: vozCap, v: narr.v, duracionFicha: narr.d }
  estado.segmento = -1
  precargado = null
  velocidadActual = velocidadDe(slug)
  if (!mismo) {
    // #t= es un media fragment: Safari arranca ahí aunque todavía no haya metadatos.
    audio.src = `${rutas.audio(slug, cap.n, narr.v, vozCap)}${inicio > 0.5 ? `#t=${inicio.toFixed(1)}` : ''}`
    busquedaPendiente = inicio > 0.5 ? inicio : null
    audio.load()
  } else if (t !== null) {
    irA(t)
  }
  aplicarVelocidad()
  guardarProgreso(slug, { cap: cap.n, t: inicio, vel: velocidadActual, fin: false, vozT: vozCap, ...(voz !== undefined ? { voz } : {}) })
  const sonar = reproducir ? play() : null
  actualizarSesionMedia()
  emitir('capitulo', estado)
  const capAhora = estado.cap
  try {
    const d = await datos
    if (estado.cap === capAhora) {
      estado.cap = { ...d, ...capAhora, segmentos: d.segmentos, bloques: d.bloques, titulo: d.titulo || capAhora.titulo }
      estado.segmento = -1
      if (audio.readyState > 0) marcarSegmento(true)
      if (corregir) {
        const capViejo = await api.capitulo(slug, cap.n, corregir.voz, corregir.v).catch(() => null)
        const ahora = audio.currentTime || busquedaPendiente || inicio
        // Solo si nadie movió la posición mientras tanto (un toque, ±15/30, la barra).
        if (capViejo && estado.cap?.n === capAhora.n && estado.cap?.voz === capAhora.voz && Math.abs(ahora - inicio) < 6) {
          const exacto = tiempoEquivalente(capViejo, corregir.t, estado.cap)
          if (Math.abs(exacto - inicio) > 0.3) irA(exacto + Math.max(0, ahora - inicio))
        }
      }
    }
  } catch (e) {
    if (estado.cap === capAhora && !navigator.onLine) avisar('Sin conexión: el texto de este capítulo no está en el teléfono')
    else if (estado.cap === capAhora) throw e
  }
  await sonar
  return estado
}

/** En qué voz se midió el `t` guardado: `vozT` desde el 10 nov; antes, la elegida a mano o la voz del libro. */
function vozDelTiempo(p, ficha) {
  return p?.vozT || p?.voz || ficha?.voz || null
}

/** Cambia la voz del libro. Si ese libro está sonando, sigue en la MISMA oración con la voz nueva. */
export async function cambiarVoz(slug, voz) {
  // Antes de cambiar la elegida, deja dicho en qué voz se midió el minuto guardado (la próxima carga lo traduce).
  const p = progreso(slug)
  const vozT = p && !p.vozT ? vozDelTiempo(p, estado.ficha?.slug === slug ? estado.ficha : api.libroGuardado(slug)) : null
  guardarProgreso(slug, { voz, ...(vozT ? { vozT } : {}) })
  if (estado.libro?.slug !== slug || !estado.cap) return emitir('voz', voz)
  const viejo = estado.cap
  const { libro } = await fichaDe(slug, voz)
  const cap = libro.capitulos.find((c) => c.n === viejo.n)
  if (!cap?.audio || cap.voz === viejo.voz) {
    estado.libro = libro
    emitir('capitulo', estado)
    emitir('voz', voz)
    if (cap?.otraVoz) avisar(`Este capítulo aún no está en la voz de ${nombreVoz(libro, voz)}: sigue en ${nombreVoz(libro, cap.voz)}`, 3500)
    return
  }
  const sonando = !audio.paused
  const nuevo = await api.capitulo(slug, cap.n, cap.voz, cap.v)
  const t = viejo.segmentos.length ? tiempoEquivalente(viejo, audio.currentTime, nuevo) : audio.currentTime
  await cargar(slug, cap.n, { t, reproducir: sonando, voz })
  emitir('voz', voz)
}

audio.addEventListener('loadedmetadata', () => {
  if (busquedaPendiente !== null && Math.abs(audio.currentTime - busquedaPendiente) > 1) {
    try { audio.currentTime = Math.min(busquedaPendiente, (audio.duration || Infinity) - 0.5) } catch { /* se reintenta al reproducir */ }
  }
  busquedaPendiente = null
  aplicarVelocidad()
  posicionSesion()
  emitir('tiempo', tiempos())
})

// ── Transporte ───────────────────────────────────────────────────────────
export async function play() {
  if (!audio.src) return
  aplicarVelocidad()
  try {
    await audio.play()
  } catch (e) {
    if (e?.name === 'AbortError') return // un pause() o cambio de capítulo interrumpió el play: normal
    if (e?.name === 'NotAllowedError') avisar('Toca play para empezar')
    else if (!navigator.onLine) avisar('Sin conexión: descarga este capítulo para oírlo offline')
    else avisar('No pude reproducir este capítulo')
  }
}
export function pausa() { audio.pause() }
export function alternar() { return audio.paused ? play() : pausa() }

export function irA(t) {
  const dur = duracion()
  const destino = Math.max(0, dur ? Math.min(t, dur - 0.25) : t)
  if (audio.readyState === 0) { busquedaPendiente = destino; return }
  audio.currentTime = destino
  emitir('tiempo', tiempos())
}
export const saltar = (delta) => irA(audio.currentTime + delta)
export const atras = () => saltar(-SALTO_ATRAS)
export const adelante = () => saltar(SALTO_ADELANTE)

export function irASegmento(i) {
  const seg = estado.cap?.segmentos?.[i]
  if (!seg) return
  irA(seg[0] + 0.01)
  marcarSegmento(true)
  if (audio.paused) play()
}

function capituloVecino(dir) {
  if (!estado.libro || !estado.cap) return null
  const caps = estado.libro.capitulos.filter((c) => c.audio)
  const i = caps.findIndex((c) => c.n === estado.cap.n)
  return caps[i + dir] || null
}
export const hayAnterior = () => !!capituloVecino(-1)
export const haySiguiente = () => !!capituloVecino(1)

export async function capituloSiguiente(reproducir = !audio.paused) {
  const c = capituloVecino(1)
  if (c) await cargar(estado.libro.slug, c.n, { t: 0, reproducir })
}
export async function capituloAnterior(reproducir = !audio.paused) {
  // Como en cualquier reproductor: si ya avanzaste, «anterior» primero regresa al inicio del capítulo.
  if (audio.currentTime > 5) return irA(0)
  const c = capituloVecino(-1)
  if (c) await cargar(estado.libro.slug, c.n, { t: 0, reproducir })
  else irA(0)
}

// ── Velocidad (criterio duro: visible, 0.75×–3×, tono conservado, por libro) ──
export const velocidad = () => velocidadActual
export function ponerVelocidad(v) {
  v = Math.round(Math.min(VEL_MAX, Math.max(VEL_MIN, Number(v))) * 100) / 100
  velocidadActual = v
  aplicarVelocidad()
  guardarPref('ultimaVel', v)
  if (estado.libro) guardarProgreso(estado.libro.slug, { vel: v, cap: estado.cap?.n, t: audio.currentTime, ...(estado.cap?.voz ? { vozT: estado.cap.voz } : {}) })
  posicionSesion()
  emitir('velocidad', v)
}
// iOS a veces regresa playbackRate a 1 al cambiar de src o al volver de una interrupción.
audio.addEventListener('ratechange', () => {
  if (Math.abs(audio.playbackRate - velocidadActual) > 0.01 && !audio.seeking) aplicarVelocidad()
})

// ── Tiempos ──────────────────────────────────────────────────────────────
export function duracion() {
  return Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : estado.cap?.duracionFicha || estado.cap?.duracion || 0
}

export function tiempos() {
  const t = audio.currentTime || busquedaPendiente || 0
  const dur = duracion()
  let restoLibro = Math.max(0, dur - t)
  let previo = 0
  let total = 0
  for (const c of estado.libro?.capitulos || []) {
    total += c.duracion
    if (estado.cap && c.n > estado.cap.n) restoLibro += c.duracion
    if (estado.cap && c.n < estado.cap.n) previo += c.duracion
  }
  return {
    t, dur, vel: velocidadActual,
    restoCap: Math.max(0, dur - t) / velocidadActual,
    restoLibro: restoLibro / velocidadActual,
    fraccionLibro: total ? (previo + t) / total : 0,
    pausado: audio.paused,
  }
}

/** Segmento que suena ahora: búsqueda binaria sobre el tiempo del MEDIO (no del reloj), así no se
 *  desincroniza a ninguna velocidad. */
export function segmentoEn(t, segs = estado.cap?.segmentos || []) {
  return segmentoEnTiempo(t, segs)
}

function marcarSegmento(forzar = false) {
  const i = segmentoEn(audio.currentTime)
  if (i !== estado.segmento || forzar) {
    estado.segmento = i
    emitir('segmento', i)
  }
}

// rAF mientras suena y la pantalla está visible: resaltado fluido (timeupdate solo llega ~4 veces/s).
let rafId = 0
function bucle() {
  marcarSegmento()
  rafId = audio.paused || document.hidden ? 0 : requestAnimationFrame(bucle)
}
const arrancarBucle = () => { if (!rafId && !audio.paused && !document.hidden) rafId = requestAnimationFrame(bucle) }

// ── Persistencia de posición ─────────────────────────────────────────────
let ultimoGuardado = 0
function guardarPosicion(sincronizar = false) {
  if (!estado.libro || !estado.cap || audio.readyState === 0) return
  guardarProgreso(estado.libro.slug, { cap: estado.cap.n, t: audio.currentTime, vel: velocidadActual, vozT: estado.cap.voz }, { sincronizar })
  ultimoGuardado = Date.now()
}

audio.addEventListener('timeupdate', () => {
  marcarSegmento()
  emitir('tiempo', tiempos())
  if (Date.now() - ultimoGuardado > 5000) guardarPosicion(Date.now() - ultimoGuardado > 30000)
  revisarSueño()
  precargarSiguiente()
})

// ── Precarga del capítulo siguiente ──────────────────────────────────────
// A 90 s del final (en tiempo real, según la velocidad): ficha fresca (el narrador pudo terminar el
// siguiente mientras sonaba este), su texto alineado y los primeros ~45 s de su audio vía el service worker.
let precargado = null
async function precargarSiguiente() {
  const dur = duracion()
  if (!estado.libro || !estado.cap || !dur || !navigator.onLine) return
  const clave = `${estado.libro.slug}/${estado.cap.n}/${estado.cap.voz}`
  if ((dur - audio.currentTime) / velocidadActual > 90 || precargado === clave) return
  precargado = clave
  const slug = estado.libro.slug
  try {
    const ficha = await api.libro(slug, { fresca: true })
    if (estado.libro?.slug !== slug) return
    estado.ficha = ficha
    estado.libro = conVoz(ficha, vozDe(slug))
    const sig = capituloVecino(1)
    if (!sig) return
    api.capitulo(slug, sig.n, sig.voz, sig.v).catch(() => {})
    const sw = navigator.serviceWorker?.controller
    if (sw) sw.postMessage({ tipo: 'precargar', url: new URL(rutas.audio(slug, sig.n, sig.v, sig.voz), location.href).href, bytes: precargaBytes })
  } catch { /* sin red: el siguiente se pedirá al llegar */ }
}
export let precargaBytes = 512 * 1024
export const ponerPrecarga = (b) => { precargaBytes = b } // para las pruebas
audio.addEventListener('play', () => { aplicarVelocidad(); arrancarBucle(); emitir('estado', 'play'); posicionSesion() })
audio.addEventListener('playing', () => { aplicarVelocidad(); emitir('estado', 'play') })
audio.addEventListener('pause', () => { guardarPosicion(true); emitir('estado', 'pausa'); posicionSesion() })
audio.addEventListener('seeked', () => { marcarSegmento(true); guardarPosicion(); posicionSesion() })
audio.addEventListener('waiting', () => emitir('estado', 'cargando'))
audio.addEventListener('progress', () => emitir('tiempo', tiempos()))
audio.addEventListener('error', () => {
  if (!audio.src) return
  avisar(navigator.onLine ? 'No pude cargar el audio de este capítulo' : 'Sin conexión: este capítulo no está descargado', 4500)
  emitir('estado', 'pausa')
})
audio.addEventListener('ended', async () => {
  if (estado.sueño?.finCapitulo) { estado.sueño = null; emitir('sueño', null); guardarPosicion(true); return }
  const sig = capituloVecino(1)
  if (sig) {
    await cargar(estado.libro.slug, sig.n, { t: 0, reproducir: true }).catch(() => avisar('No pude abrir el siguiente capítulo'))
  } else {
    guardarProgreso(estado.libro.slug, { cap: estado.cap.n, t: 0, fin: true }, { sincronizar: true })
    emitir('estado', 'fin')
  }
})
document.addEventListener('visibilitychange', () => {
  if (document.hidden) guardarPosicion(true)
  else { arrancarBucle(); marcarSegmento(true) }
})
addEventListener('pagehide', () => guardarPosicion(true))
addEventListener('online', () => sincronizarPendientes())

// ── Temporizador de sueño ────────────────────────────────────────────────
export function ponerSueño(minutos) {
  if (minutos === 'cap') estado.sueño = { finCapitulo: true }
  else if (minutos) estado.sueño = { fin: Date.now() + minutos * 60000 }
  else estado.sueño = null
  emitir('sueño', estado.sueño)
}
function revisarSueño() {
  if (estado.sueño?.fin && Date.now() >= estado.sueño.fin) {
    estado.sueño = null
    pausa()
    emitir('sueño', null)
  }
}
setInterval(revisarSueño, 5000)

// ── Media Session (pantalla bloqueada, audífonos, CarPlay) ───────────────
const ms = 'mediaSession' in navigator ? navigator.mediaSession : null
function manejador(accion, fn) { try { ms?.setActionHandler(accion, fn) } catch { /* acción no soportada */ } }
manejador('play', () => play())
manejador('pause', () => pausa())
manejador('stop', () => pausa())
manejador('seekbackward', (d) => saltar(-(d?.seekOffset || SALTO_ATRAS)))
manejador('seekforward', (d) => saltar(d?.seekOffset || SALTO_ADELANTE))
manejador('seekto', (d) => { if (Number.isFinite(d?.seekTime)) irA(d.seekTime) })
manejador('previoustrack', () => capituloAnterior(true))
manejador('nexttrack', () => capituloSiguiente(true))

async function actualizarSesionMedia() {
  if (!ms || !estado.libro || !estado.cap) return
  const { libro, cap } = estado
  // Con varias voces, la pantalla bloqueada dice cuál suena.
  const variasVoces = (libro.voces || []).filter((v) => v.narrados > 0).length > 1
  const datos = { title: cap.titulo, artist: variasVoces ? `${libro.autor} · voz de ${nombreVoz(libro, cap.voz)}` : libro.autor, album: libro.titulo }
  ms.metadata = new MediaMetadata(datos)
  try { ms.metadata = new MediaMetadata({ ...datos, artwork: await arteParaPantallaBloqueada(libro) }) } catch { /* sin carátula */ }
}

let ultimaPosicion = 0
function posicionSesion() {
  if (!ms?.setPositionState) return
  const dur = duracion()
  if (!dur) return
  try {
    ms.setPositionState({ duration: dur, playbackRate: velocidadActual, position: Math.min(audio.currentTime || 0, dur) })
    ultimaPosicion = Date.now()
  } catch { /* valores fuera de rango durante cargas */ }
}
audio.addEventListener('timeupdate', () => { if (Date.now() - ultimaPosicion > 10000) posicionSesion() })

// Carga silenciosa del último libro para que «Continuar» suene al primer toque.
export async function prepararUltimo(slug) {
  if (estado.libro || !slug) return
  const p = progreso(slug)
  if (!p) return
  // Sin `t`: cargar retoma de p.t y, si ese minuto se midió en otra voz, lo traduce a la misma oración.
  try { await cargar(slug, p.cap) } catch { /* el libro pudo cambiar */ }
}

export async function capitulosDescargados() {
  return estado.libro ? estadoDescargas(estado.libro) : {}
}
export const formatoCap = (c) => `Capítulo ${nn(c.n)}`
