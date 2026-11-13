// El lector sigue a la voz PALABRA a PALABRA: tan fluido como un lector de chat con voz, adaptado a la UX de un libro.
//
// Tres piezas:
//  · La caja → UNA caja que se MUEVE a la palabra que suena (nunca rastro: no hay dos, ni clases por palabra
//    que WebKit olvide repintar). Aquí vive dentro de .texto y DETRÁS de las letras (isolation + z-index -1), así la
//    palabra se lee en su propia tinta y la caja acompaña al scroll de la página sin código.
//  · palabraEn: búsqueda binaria sobre el inicio EXACTO de cada palabra (Qwen3-ForcedAligner, el
//    servidor la manda en "palabras"). El reloj es currentTime del <audio>, nunca un reloj propio: no se desfasa a
//    ninguna velocidad.
//  · El seguimiento → quién lleva el scroll: si la mano movió el texto, NADA lo mueve hasta que regreses con la mano a
//    lo que suena o navegue (tocar una palabra, «Volver a la voz»). Play/pausa no regresan el scroll.
//  · El deslizamiento → propio cuadro a cuadro con curva de salida, cancelable con la mano; nunca
//    behavior:'smooth' (no se puede cancelar y en WebKit deja mosaicos sin pintar).
// Con "palabras" vacía (capítulo aún sin alinear) todo sigue por oración, con el mismo seguimiento.
import * as R from './reproductor.js'
import { esc } from './util.js'

export const FIN_GESTO_MS = 350 // sin scroll ni dedo durante este tiempo, el gesto de la mano (con su inercia) terminó
export const BANDA = 0.38 // la línea que suena vive a este alto del área visible (entre la barra y el panel)
export const DESLIZAR_MS = 400
export const SALTO_PANTALLAS = 1.5 // más lejos que esto, el viaje es instantáneo (buscar, ±15/30, capítulo)
const PILDORA_RETRASO_MS = 260
const TECLAS_DE_SCROLL = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])
const FUERA_DEL_TEXTO = '.panel, #hoja, .volver-voz, .lector-top, #mini'

/** Índice de la palabra que suena en `t`: la última que ya empezó (empates: la última). Pura, para el test. */
export function palabraEn(inicios, t) {
  let lo = 0
  let hi = inicios.length - 1
  if (hi < 0) return -1
  if (t < inicios[0]) return 0
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (inicios[mid] <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Curva del deslizamiento (sale rápido, llega despacio). */
export const curva = (t) => 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3)

/** Quién lleva el scroll: la voz o la mano. */
export class Seguimiento {
  suelto = false
  mano() { this.suelto = true }
  retomar() { this.suelto = false }
  manoTermino(aLaVista) { if (aLaVista) this.suelto = false }
  get lleva() { return !this.suelto }
}

const ETIQUETAS = { h1: 'h1', h2: 'h2', p: 'p', q: 'blockquote', li: 'div' }

/**
 * HTML del capítulo. Cada palabra de `palabras` ([t0, t1, b, desde, hasta], offsets UTF-16 sobre el texto del bloque)
 * va en <span class="w" data-w="k"> dentro de su oración (.seg); si cruza tramos (un énfasis) son varios spans con el
 * mismo data-w. Sin palabras, el mismo HTML de siempre.
 */
export function cuerpoHtml(bloques, palabras = []) {
  const porBloque = new Map()
  palabras.forEach((p, k) => {
    const [, , b, desde, hasta] = p
    if (!(hasta > desde) || !bloques[b]) return
    if (!porBloque.has(b)) porBloque.set(b, [])
    porBloque.get(b).push([desde, hasta, k])
  })
  for (const l of porBloque.values()) l.sort((x, y) => x[0] - y[0])
  return bloques.map((b, bi) => {
    const tag = ETIQUETAS[b.tipo] || 'p'
    const ws = porBloque.get(bi) || []
    let j = 0
    let off = 0
    const dentro = b.tramos.map(([t, s, m]) => {
      const fin = off + t.length
      let x = ''
      let pos = off
      while (pos < fin) {
        while (j < ws.length && ws[j][1] <= pos) j++
        const w = ws[j]
        if (!w || w[0] >= fin) { x += esc(t.slice(pos - off)); break }
        if (w[0] > pos) { x += esc(t.slice(pos - off, w[0] - off)); pos = w[0] }
        const hasta = Math.min(w[1], fin)
        x += `<span class="w" data-w="${w[2]}">${esc(t.slice(pos - off, hasta - off))}</span>`
        pos = hasta
      }
      off = fin
      if (m === 'em') x = `<em>${x}</em>`
      else if (m === 'strong') x = `<b>${x}</b>`
      return s >= 0 ? `<span class="seg" data-s="${s}">${x}</span>` : x
    }).join('')
    return `<${tag}${b.tipo === 'li' ? ' class="li"' : ''}>${dentro}</${tag}>`
  }).join('')
}

const reduceMovimiento = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Monta el resaltado y el seguimiento sobre el texto ya pintado. Devuelve { limpiar, lleva }.
 * `altoPanel()` = lo que tapa el reproductor abajo; `alTocarOracion(s)` = el toque sin palabras (por oración).
 */
export function montarLector({ texto, barra, volver, cap, vinculado, altoPanel, alTocar, tInicial = 0 }) {
  const palabras = (cap.palabras || []).filter((p) => Array.isArray(p) && p.length >= 5)
  const inicios = palabras.map((p) => p[0])
  const porPalabra = new Map()
  for (const el of texto.querySelectorAll('.w')) {
    const k = Number(el.dataset.w)
    if (!porPalabra.has(k)) porPalabra.set(k, [])
    porPalabra.get(k).push(el)
  }
  const porSeg = new Map()
  for (const el of texto.querySelectorAll('.seg')) {
    const s = Number(el.dataset.s)
    if (!porSeg.has(s)) porSeg.set(s, [])
    porSeg.get(s).push(el)
  }
  const conPalabras = porPalabra.size > 0
  texto.classList.toggle('por-palabra', conPalabras)
  const seg = new Seguimiento()
  const quitar = []
  const escuchar = (blanco, ev, fn, opts = { passive: true }) => { blanco.addEventListener(ev, fn, opts); quitar.push(() => blanco.removeEventListener(ev, fn, opts)) }
  const medidas = { cuadros: 0, lentos: 0, peorCuadro: 0, movimientos: 0, saltos: 0, cambiosDeLinea: 0, deslizamientos: 0, instantaneos: 0, peorTrabajo: 0, desde: performance.now() }

  // ── Zona de lectura y deslizamiento propio ──
  const zona = () => {
    const arriba = barra ? barra.getBoundingClientRect().bottom : 0
    const abajo = innerHeight - (altoPanel() || 0)
    return { arriba, abajo, alto: Math.max(1, abajo - arriba) }
  }
  const yBanda = (z = zona()) => z.arriba + z.alto * BANDA
  /** La línea quedó donde se puede leer cómoda (no pegada a la barra ni bajo el panel). */
  const comoda = (r, z = zona()) => r.top >= z.arriba + 2 && r.bottom <= z.arriba + z.alto * 0.82

  let anim = 0
  const pararDeslizar = () => { if (anim) cancelAnimationFrame(anim); anim = 0 }
  quitar.push(pararDeslizar)
  const deslizarA = (destino, { instantaneo = false } = {}) => {
    pararDeslizar()
    const max = Math.max(0, document.documentElement.scrollHeight - innerHeight)
    const hasta = Math.max(0, Math.min(max, Math.round(destino)))
    const desde = scrollY
    if (Math.abs(hasta - desde) < 1) return
    if (instantaneo || reduceMovimiento() || Math.abs(hasta - desde) > SALTO_PANTALLAS * innerHeight) {
      medidas.instantaneos++
      scrollTo(0, hasta)
      return
    }
    medidas.deslizamientos++
    const t0 = performance.now()
    const paso = () => {
      const t = (performance.now() - t0) / DESLIZAR_MS
      scrollTo(0, desde + (hasta - desde) * curva(t))
      anim = t < 1 ? requestAnimationFrame(paso) : 0
    }
    anim = requestAnimationFrame(paso)
  }
  /** Lleva el rect `r` (en pantalla) a la banda de lectura. */
  const aLaBanda = (r, opts) => {
    const d = r.top - yBanda()
    if (Math.abs(d) > 2) deslizarA(scrollY + d, opts)
  }

  // ── La caja: un solo elemento que se mueve ──
  let caja = null
  if (conPalabras) {
    texto.querySelectorAll('.caja-palabra').forEach((n) => n.remove())
    caja = document.createElement('div')
    caja.className = 'caja-palabra'
    caja.setAttribute('aria-hidden', 'true')
    caja.hidden = true
    texto.prepend(caja)
    quitar.push(() => caja.remove())
  }
  let activa = -1 // palabra resaltada
  let lineaY = null // top (en el texto) de la línea de la palabra resaltada
  let encendidas = []

  /** Rect de la palabra en su primera línea (una palabra cortada con guion vive en dos; la caja va en la primera). */
  const rectDe = (k) => {
    const els = porPalabra.get(k)
    if (!els) return null
    let u = null
    for (const el of els) for (const r of el.getClientRects()) {
      if (!(r.width > 0 && r.height > 0)) continue
      if (!u) { u = { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; continue }
      if (Math.abs(r.top - u.top) > r.height / 2) continue
      u.left = Math.min(u.left, r.left); u.right = Math.max(u.right, r.right); u.bottom = Math.max(u.bottom, r.bottom)
    }
    return u && { ...u, width: u.right - u.left, height: u.bottom - u.top }
  }

  const apagarCaja = () => {
    if (caja) caja.hidden = true
    for (const el of encendidas) el.classList.remove('suena')
    encendidas = []
    activa = -1
    lineaY = null
  }

  /** Mueve la caja a la palabra `k`. `seguir`: si cambió de línea y la voz lleva el scroll, la línea va a la banda. */
  const moverA = (k, { animar = true, seguir = true, instantaneo = false } = {}) => {
    const t = performance.now()
    const r = rectDe(k)
    if (!r) return
    const tr = texto.getBoundingClientRect()
    const x = r.left - tr.left
    const y = r.top - tr.top
    const mismaLinea = lineaY !== null && Math.abs(y - lineaY) < 2 && !caja.hidden
    const cambioLinea = !mismaLinea
    caja.classList.toggle('salta', !(animar && mismaLinea))
    caja.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`
    caja.style.width = `${r.width.toFixed(1)}px`
    caja.style.height = `${r.height.toFixed(1)}px`
    caja.hidden = false
    if (k !== activa) {
      for (const el of encendidas) el.classList.remove('suena')
      encendidas = porPalabra.get(k) || []
      for (const el of encendidas) el.classList.add('suena')
      medidas.movimientos++
      if (!mismaLinea) medidas.saltos++
    }
    activa = k
    lineaY = y
    if (cambioLinea) medidas.cambiosDeLinea++
    if (seguir && seg.lleva && (cambioLinea || instantaneo) && !document.hidden) aLaBanda(r, { instantaneo })
    medidas.peorTrabajo = Math.max(medidas.peorTrabajo, performance.now() - t)
  }

  /**
   * Reloj del audio en el que se puede confiar, o null. Mientras el capítulo recién cargado no tiene metadatos (por
   * Funnel y datos, de 0.3 a 2 s) `paused` ya es false pero `currentTime` vale 0 aunque vaya a arrancar en el minuto 18:
   * ese 0 es «todavía no sé», no «el principio». Sin esta guarda el texto saltaba al inicio del capítulo y regresaba
   * (revisión adversarial, 10 nov). Tampoco durante un seek, ni el 0 de arranque cuando el lector abrió más adelante.
   */
  let relojConfirmado = !(tInicial > 0.5)
  const relojAudio = () => {
    const a = R.elemento
    if (a.readyState < 1 || a.seeking) return null
    if (!relojConfirmado) {
      if (a.currentTime < 0.05) return null
      relojConfirmado = true
    }
    return a.currentTime
  }

  /** Coloca la caja donde suena ahora (si este lector va con la voz). */
  const tic = (opts) => {
    if (!conPalabras) return
    if (!vinculado()) return apagarCaja()
    const t = relojAudio()
    if (t === null) return
    const k = palabraEn(inicios, t)
    if (k !== activa || opts) moverA(k, opts)
  }

  // ── Reloj: rAF propio solo mientras suena y se ve ──
  let raf = 0
  let ultimo = 0
  const corre = () => conPalabras && texto.isConnected && vinculado() && !R.elemento.paused && !document.hidden
  const cuadro = (ahora) => {
    raf = 0
    if (!corre()) { ultimo = 0; return }
    if (ultimo) {
      const dt = ahora - ultimo
      medidas.cuadros++
      if (dt > 32) medidas.lentos++
      medidas.peorCuadro = Math.max(medidas.peorCuadro, dt)
    }
    ultimo = ahora
    tic()
    raf = requestAnimationFrame(cuadro)
  }
  const despertar = () => { if (!raf && corre()) raf = requestAnimationFrame(cuadro) }
  quitar.push(() => { if (raf) cancelAnimationFrame(raf); raf = 0 })

  // ── Oración (.activa/.oida, como siempre) y seguimiento por oración sin palabras ──
  let oracion = -1
  const marcarOidas = (desde, hasta, on) => {
    for (let s = Math.max(0, desde); s < hasta; s++) for (const el of porSeg.get(s) || []) el.classList.toggle('oida', on)
  }
  /** Sin palabras, la oración solo se mueve si se sale de la zona cómoda (no a cada oración); `forzar` la trae igual. */
  const traerOracion = (i, { forzar = false, instantaneo = false } = {}) => {
    const el = porSeg.get(i)?.[0]
    if (!el || document.hidden) return
    const r = el.getBoundingClientRect()
    const z = zona()
    if (forzar || r.top < z.arriba + 8 || r.bottom > z.abajo - 40) aLaBanda(r, { instantaneo })
  }
  const resaltarOracion = (i, desplazar = true) => {
    if (!vinculado()) i = -1
    if (i === oracion) return
    for (const el of porSeg.get(oracion) || []) el.classList.remove('activa')
    if (i > oracion) marcarOidas(oracion, i, true)
    else marcarOidas(i, oracion + 1, false)
    oracion = i
    for (const el of porSeg.get(i) || []) el.classList.add('activa')
    if (!conPalabras && desplazar && seg.lleva) traerOracion(i)
  }
  /** Lleva lo que suena a la banda (volver a la voz, abrir el lector, letra nueva). */
  const traerLoQueSuena = (opts) => {
    if (conPalabras) { const r = activa >= 0 && rectDe(activa); if (r) aLaBanda(r, opts) }
    else if (oracion >= 0) traerOracion(oracion, { ...opts, forzar: true })
  }
  const sonando = () => vinculado() && !R.elemento.paused
  const ponerSonando = () => texto.classList.toggle('sonando', sonando())

  // ── Píldora «Volver a la voz»: solo terminado el gesto, y toca solo ya visible ──
  let tPildora = 0
  const ocultarPildora = () => {
    clearTimeout(tPildora)
    volver.classList.remove('visible', 'lista')
    volver.hidden = true
  }
  const mostrarPildora = () => {
    clearTimeout(tPildora)
    tPildora = setTimeout(() => {
      if (seg.lleva || !sonando() || enGesto) return
      volver.hidden = false
      requestAnimationFrame(() => {
        volver.classList.add('visible')
        tPildora = setTimeout(() => volver.classList.add('lista'), 220)
      })
    }, PILDORA_RETRASO_MS)
  }
  quitar.push(() => clearTimeout(tPildora))
  volver.onclick = () => {
    if (!volver.classList.contains('lista')) return
    seg.retomar()
    ocultarPildora()
    tic({ animar: false, seguir: false })
    traerLoQueSuena()
  }

  // ── La mano ──
  let enGesto = false
  let dedo = false
  let tGesto = 0
  const loQueSuenaSeVe = () => {
    const z = zona()
    if (conPalabras) { const r = activa >= 0 && rectDe(activa); return !!r && comoda(r, z) }
    const el = porSeg.get(oracion)?.[0]
    if (!el) return false
    const r = el.getBoundingClientRect()
    return r.bottom > z.arriba + 2 && r.top < z.abajo - 20
  }
  const terminoGesto = () => {
    clearTimeout(tGesto)
    tGesto = setTimeout(() => {
      if (dedo) return
      enGesto = false
      seg.manoTermino(loQueSuenaSeVe())
      if (seg.lleva) ocultarPildora()
      else mostrarPildora()
    }, FIN_GESTO_MS)
  }
  quitar.push(() => clearTimeout(tGesto))
  const mano = () => {
    seg.mano()
    pararDeslizar()
    enGesto = true
    ocultarPildora()
    terminoGesto()
  }
  const delTexto = (ev) => !(ev.target instanceof Element && ev.target.closest(FUERA_DEL_TEXTO))
  escuchar(window, 'touchstart', (ev) => { if (!delTexto(ev)) return; dedo = true; mano() })
  escuchar(window, 'touchmove', (ev) => { if (delTexto(ev)) mano() })
  const soltarDedo = () => { if (!dedo) return; dedo = false; terminoGesto() }
  escuchar(window, 'touchend', soltarDedo)
  escuchar(window, 'touchcancel', soltarDedo)
  escuchar(window, 'wheel', (ev) => { if (!(ev.target instanceof Element && ev.target.closest('#hoja'))) mano() })
  escuchar(window, 'keydown', (ev) => {
    if (!TECLAS_DE_SCROLL.has(ev.key) || ev.target.closest?.('button, input, [role="slider"], #hoja')) return
    mano()
  })
  escuchar(window, 'scroll', () => { if (enGesto) terminoGesto() })

  // ── Tocar una palabra (o una oración, sin palabras) ──
  escuchar(texto, 'click', async (ev) => {
    if (!cap.audio || getSelection()?.toString()) return
    const w = conPalabras && ev.target.closest('.w')
    const el = ev.target.closest('.seg')
    if (!w && !el) return
    seg.retomar()
    ocultarPildora()
    if (w) {
      const k = Number(w.dataset.w)
      const t = palabras[k][0]
      for (const x of porPalabra.get(k) || []) { x.classList.remove('tocada'); void x.offsetWidth; x.classList.add('tocada') }
      if (vinculado()) {
        R.irA(t + 0.01)
        moverA(k, { animar: false })
        if (R.elemento.paused) R.play()
      } else await alTocar({ t })
      return
    }
    el.classList.add('tocada')
    setTimeout(() => el.classList.remove('tocada'), 650)
    await alTocar({ s: Number(el.dataset.s) })
  }, false)

  // ── Lo que mueve el texto sin cambiar de palabra: letra nueva, rotación, fuentes ──
  let primera = true
  const recolocar = () => {
    if (primera) { primera = false; return }
    if (conPalabras && activa >= 0) moverA(activa, { animar: false, instantaneo: true, seguir: seg.lleva })
    else if (seg.lleva && oracion >= 0 && vinculado()) traerOracion(oracion, { forzar: true, instantaneo: true })
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(recolocar) : null
  ro?.observe(texto)
  quitar.push(() => ro?.disconnect())

  escuchar(document, 'visibilitychange', () => {
    if (document.hidden) return
    // Al volver a la pantalla, lo que suena está donde lo dejó la voz: sin animar el viaje.
    tic({ animar: false, instantaneo: true })
    despertar()
  })
  quitar.push(R.on('segmento', (e) => resaltarOracion(e.detail)))
  quitar.push(R.on('estado', () => {
    ponerSonando()
    if (R.elemento.paused) ocultarPildora()
    else if (!seg.lleva && !loQueSuenaSeVe()) mostrarPildora() // play no regresa el scroll; ofrece volver
    tic()
    despertar()
  }))
  // En pausa, buscar (barra, ±15/30) mueve la caja una vez; sonando, el bucle ya lo hace.
  quitar.push(R.on('tiempo', () => { if (R.elemento.paused) tic() }))

  // Estado inicial: lo que suena, en la banda, sin viaje animado.
  ponerSonando()
  if (vinculado()) {
    const t = R.elemento.currentTime || tInicial || 0
    resaltarOracion(R.segmentoEn(t, cap.segmentos), false)
    requestAnimationFrame(() => {
      if (!texto.isConnected) return
      if (conPalabras) { const k = palabraEn(inicios, t); if (k >= 0) moverA(k, { animar: false, instantaneo: t > 0.5 }) }
      else if (oracion > 0) traerOracion(oracion, { forzar: true, instantaneo: true })
      despertar()
    })
  }

  // Para el arnés e2e y la medición de fluidez.
  const sonda = {
    conPalabras,
    activa: () => activa,
    esperada: () => palabraEn(inicios, R.elemento.currentTime),
    lleva: () => seg.lleva,
    palabras: () => palabras,
    caja: () => (caja && !caja.hidden ? caja.getBoundingClientRect() : null),
    rect: (k) => rectDe(k),
    zona,
    medidas: () => ({ ...medidas, segundos: (performance.now() - medidas.desde) / 1000 }),
    reiniciar: () => { Object.assign(medidas, { cuadros: 0, lentos: 0, peorCuadro: 0, movimientos: 0, saltos: 0, cambiosDeLinea: 0, deslizamientos: 0, instantaneos: 0, peorTrabajo: 0, desde: performance.now() }) },
  }
  window.__lector = sonda
  quitar.push(() => { if (window.__lector === sonda) delete window.__lector })

  return {
    lleva: () => seg.lleva,
    limpiar: () => { quitar.splice(0).forEach((q) => q()); texto.classList.remove('sonando') },
  }
}
