// Recorrido e2e en WebKit con viewport de iPhone 15 Pro Max: login → biblioteca → libro → reproducir →
// leer sincronizado → velocidad (criterio duro) → toque-a-oración → Media Session → recarga → voces (elegir,
// cambiar conservando la oración, pedir otra) → precarga del siguiente capítulo → descarga → modo avión.
// Palabra a palabra (10 nov 2026): el libro de prueba trae su alineación REAL por palabra (fixtures/palabras, la hizo
// Qwen3-ForcedAligner); «Segundo libro de prueba» no la trae y sigue por oración. Fluidez → salida/fluidez.json.
// Deja capturas en tests/e2e/salida/ y sale con código ≠ 0 si algo falla.
import { webkit, chromium, devices } from 'playwright'
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { crearServidor } from '../../server/index.mjs'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '../..')
const salida = join(raiz, 'tests/e2e/salida')
mkdirSync(salida, { recursive: true })

// Biblioteca de prueba: el fixture dos veces (para probar velocidad por libro) + libros reales si se pide.
const libros = mkdtempSync(join(tmpdir(), 'audioteca-e2e-'))
cpSync(join(raiz, 'fixtures/libros/prueba-audioteca'), join(libros, 'prueba-audioteca'), { recursive: true })
cpSync(join(raiz, 'fixtures/libros/prueba-audioteca'), join(libros, 'prueba-dos'), { recursive: true })
const ficha2 = JSON.parse(readFileSync(join(libros, 'prueba-dos/libro.json'), 'utf8'))
writeFileSync(join(libros, 'prueba-dos/libro.json'), JSON.stringify({ ...ficha2, slug: 'prueba-dos', titulo: 'Segundo libro de prueba', autor: 'Otra autora', estado: 'completo', capitulos: ficha2.capitulos.slice(0, 2) }))
// E2E_BIBLIOTECA=/ruta/a/biblioteca: agrega además tus libros reales (solo lectura: se copian a una carpeta temporal).
if (process.env.E2E_BIBLIOTECA) {
  for (const s of readdirSync(process.env.E2E_BIBLIOTECA)) if (existsSync(join(process.env.E2E_BIBLIOTECA, s, 'libro.json'))) cpSync(join(process.env.E2E_BIBLIOTECA, s), join(libros, s), { recursive: true })
}

// Mac de mentira: carpeta de voces (trinity se puede pedir) y narrador con su cola.
const voces = mkdtempSync(join(tmpdir(), 'audioteca-e2e-voces-'))
writeFileSync(join(voces, 'trinity.wav'), 'RIFF')
writeFileSync(join(voces, 'trinity.txt'), 'Hola.')
const narrador = mkdtempSync(join(tmpdir(), 'audioteca-e2e-narrador-'))
writeFileSync(join(narrador, 'cola.json'), JSON.stringify({ orden: ['prueba-audioteca'], excluidos: [] }))

// Datos del servidor: la alineación por palabra del libro de prueba (contrato: <datos>/palabras/<slug>/<voz>/NN.json).
const datos = mkdtempSync(join(tmpdir(), 'audioteca-e2e-datos-'))
cpSync(join(raiz, 'fixtures/palabras/prueba-audioteca'), join(datos, 'palabras/prueba-audioteca'), { recursive: true })
const servidor = crearServidor({
  puerto: 0, host: '127.0.0.1', libros, narrador, voces, datos, prefijo: '/audioteca', cookieSegura: false,
  contraseña: 'correcta',
}).listen(0)
await new Promise((r) => servidor.once('listening', r))
const BASE = `http://localhost:${servidor.address().port}/audioteca/`

const resultados = []
let fallos = 0
const ok = (nombre, cond, detalle = '') => {
  resultados.push(`${cond ? '✔' : '✘'} ${nombre}${detalle ? ` — ${detalle}` : ''}`)
  if (!cond) fallos++
  console.log(resultados[resultados.length - 1])
}
const espera = (ms) => new Promise((r) => setTimeout(r, ms))

const motor = process.env.E2E_MOTOR === 'chromium' ? chromium : webkit
const navegador = await motor.launch()
const contexto = await navegador.newContext({ ...devices['iPhone 15 Pro Max'], ...(motor === chromium ? { isMobile: true } : {}), serviceWorkers: 'allow', locale: 'es-MX' })
// Espía de Media Session: registra handlers y el último setPositionState para poder verificarlos.
await contexto.addInitScript(() => {
  window.__ms = { handlers: {}, posicion: null }
  const ms = navigator.mediaSession
  if (!ms) return
  const set = ms.setActionHandler.bind(ms)
  ms.setActionHandler = (a, fn) => { window.__ms.handlers[a] = fn; try { set(a, fn) } catch {} }
  const pos = ms.setPositionState?.bind(ms)
  ms.setPositionState = (p) => { window.__ms.posicion = p; try { pos?.(p) } catch {} }
})
// Las pruebas nunca suenan por las bocinas: todo <audio> va en silencio (volumen 0 y muted) y la voz del sistema
// queda apagada. El reloj (currentTime) avanza igual, que es lo único que mide el recorrido.
await contexto.addInitScript(() => {
  const silenciar = (el) => { try { el.muted = true; el.volume = 0 } catch {} }
  const original = HTMLMediaElement.prototype.play
  HTMLMediaElement.prototype.play = function (...a) { silenciar(this); return original.apply(this, a) }
  new MutationObserver(() => document.querySelectorAll('audio,video').forEach(silenciar)).observe(document, { childList: true, subtree: true })
  if (window.speechSynthesis) window.speechSynthesis.speak = () => {}
})
const pagina = await contexto.newPage()
const errores = []
pagina.on('pageerror', (e) => errores.push(e.message))
pagina.on('console', (m) => { if (m.type() === 'error' && !/401|Failed to load resource/.test(m.text())) errores.push(m.text()) })
const foto = async (n) => { await espera(450); return pagina.screenshot({ path: join(salida, `${n}.png`) }) }
const enAudio = (fn, arg) => pagina.evaluate(fn, arg)
// Palabra a palabra: lo que el lector muestra vs lo que debería (palabraEn recalculada aquí, sin usar la del lector).
const muestraPalabra = () => enAudio(() => {
  const L = window.__lector
  const t = document.getElementById('audio').currentTime
  const ini = L.palabras().map((p) => p[0])
  let k = 0
  while (k + 1 < ini.length && ini[k + 1] <= t) k++
  return { t, k, activa: L.activa(), lleva: L.lleva(), y: scrollY, texto: [...document.querySelectorAll('.w.suena')].map((e) => e.textContent).join('') }
})
// ¿La caja cubre el span de la palabra activa? ¿Su línea está en la banda (o el texto ya no puede moverse más)?
const geometria = () => enAudio(() => {
  const L = window.__lector
  const c = L.caja()
  const r = L.rect(L.activa())
  const z = L.zona()
  const banda = z.arriba + z.alto * 0.38
  const max = document.documentElement.scrollHeight - innerHeight
  const cubre = !!(c && r) && c.left <= r.left + 0.5 && c.right >= r.right - 0.5 && c.top <= r.top + 0.5 && c.bottom >= r.bottom - 0.5 && c.width < r.width + 14 && c.height < r.height + 8
  const fmt = (x) => x && `${x.left.toFixed(1)},${x.top.toFixed(1)} ${x.width.toFixed(1)}×${x.height.toFixed(1)}`
  return { cubre, caja: fmt(c), span: fmt(r), top: r?.top, banda, enBanda: !!r && Math.abs(r.top - banda) <= 3, tope: scrollY <= 0.5 || scrollY >= max - 0.5, y: scrollY, cajas: document.querySelectorAll('.caja-palabra').length }
})
// La mano mueve el texto (dedo: touchstart → scroll → touchend), como en el iPhone.
const deslizarConElDedo = (dy) => enAudio((dy) => {
  const el = document.querySelector('.texto p')
  el.dispatchEvent(new Event('touchstart', { bubbles: true }))
  scrollBy(0, dy)
  el.dispatchEvent(new Event('touchmove', { bubbles: true }))
  el.dispatchEvent(new Event('touchend', { bubbles: true }))
}, dy)

try {
  // 1. Login
  await pagina.goto(BASE)
  await pagina.waitForSelector('.entrada form')
  await foto('01-login')
  await pagina.fill('input[name=contraseña]', 'mala')
  await pagina.click('button[type=submit]')
  await pagina.waitForSelector('.error:not(:empty)')
  ok('login rechaza contraseña incorrecta', (await pagina.textContent('.error')).includes('incorrecta'))
  await pagina.fill('input[name=contraseña]', 'correcta')
  await pagina.click('button[type=submit]')
  await pagina.waitForSelector('.estante')
  ok('login correcto abre la biblioteca', true)
  await foto('02-biblioteca')

  // 2. Libro
  await pagina.click('[data-slug="prueba-audioteca"]')
  await pagina.waitForSelector('.ficha .capitulos')
  const caps = await pagina.$$eval('.capitulo', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()))
  ok('ficha lista 3 capítulos (2 narrados + 1 solo texto)', caps.length === 3 && /Solo texto/.test(caps[2]), caps.join(' | '))
  await foto('03-libro')

  // 3. Reproducir y leer
  await pagina.click('[data-accion="principal"]')
  await pagina.waitForSelector('.texto .seg')
  await pagina.waitForFunction(() => document.getElementById('audio').currentTime > 2.2, null, { timeout: 15000 })
  const a = await enAudio(() => {
    const au = document.getElementById('audio')
    const act = document.querySelector('.seg.activa')
    return { t: au.currentTime, rate: au.playbackRate, s: Number(act?.dataset.s), texto: act?.textContent, esperado: window.__audioteca.R.segmentoEn(au.currentTime) }
  })
  ok('suena y resalta la oración en curso', a.s === a.esperado && a.s >= 0, `t=${a.t.toFixed(2)} seg=${a.s} «${a.texto}»`)
  ok('velocidad por defecto 1.75×', Math.abs(a.rate - 1.75) < 0.01, `playbackRate=${a.rate}`)
  await foto('04-lector-antes')
  await espera(3500)
  const b = await enAudio(() => ({ s: Number(document.querySelector('.seg.activa')?.dataset.s), t: document.getElementById('audio').currentTime, texto: document.querySelector('.seg.activa')?.textContent }))
  ok('el resaltado avanza con la voz', b.s > a.s, `seg ${a.s} → ${b.s} «${b.texto}»`)
  await foto('05-lector-despues')

  // 4. Velocidad (criterio duro)
  const visible = await pagina.isVisible('.velocidades')
  ok('selector de velocidad visible en el reproductor', visible && (await pagina.isVisible('[data-vel="1.75"].on')) && (await pagina.isVisible('[data-vel="2"]')))
  await pagina.click('[data-vel="2"]')
  ok('2× a un toque', Math.abs(await enAudio(() => document.getElementById('audio').playbackRate) - 2) < 0.01)

  // 4a. Palabra a palabra (10 nov 2026): UNA caja que va con la palabra que suena, a 2×.
  await enAudio(() => window.__audioteca.R.irA(1))
  await pagina.waitForFunction(() => window.__lector?.conPalabras && window.__lector.activa() >= 0, null, { timeout: 5000 })
  const pp = await enAudio(() => ({ spans: document.querySelectorAll('.texto .w').length, cajas: document.querySelectorAll('.caja-palabra').length, clase: document.querySelector('.texto').classList.contains('por-palabra'), palabras: window.__lector.palabras().length }))
  ok('capítulo con tiempos por palabra: cada palabra en su span y UNA sola caja', pp.clase && pp.palabras > 50 && pp.spans >= pp.palabras && pp.cajas === 1, JSON.stringify(pp))
  await espera(600)
  const muestras = []
  for (let i = 0; i < 12; i++) { muestras.push(await muestraPalabra()); await espera(160) }
  const desfases = muestras.map((m) => m.activa - m.k)
  ok('a 2× la palabra resaltada = palabraEn(currentTime) ±1', desfases.every((d) => Math.abs(d) <= 1) && muestras.at(-1).activa > muestras[0].activa + 4,
    `desfases [${desfases.join(',')}] · palabras ${muestras[0].activa}→${muestras.at(-1).activa} · «${muestras.at(-1).texto}»`)
  await foto('04b-palabra-2x')
  await enAudio(() => document.getElementById('audio').pause())
  await espera(300)
  const g1 = await geometria()
  ok('la caja cubre el rect del span activo (y es una sola)', g1.cubre && g1.cajas === 1, `caja ${g1.caja} · span ${g1.span}`)
  // La voz lleva el scroll: un salto adelante, y al cambiar de línea el texto desliza la línea a la banda (~38 %).
  await enAudio(() => { const L = window.__lector; const R = window.__audioteca.R; R.irA(L.palabras()[Math.floor(L.palabras().length * 0.7)][0] + 0.01); R.play() })
  await espera(1500)
  await enAudio(() => document.getElementById('audio').pause())
  await espera(600)
  const g2 = await geometria()
  ok('la línea activa queda en la banda de lectura', g2.enBanda || g2.tope, `top de la línea ${g2.top?.toFixed(1)} · banda ${g2.banda.toFixed(1)} · scrollY ${g2.y}`)
  await foto('04c-linea-en-banda')
  // La mano manda: scroll con el dedo suelta el seguimiento, la página no se mueve sola y aparece la píldora.
  await enAudio(() => { window.__audioteca.R.irA(1); window.__audioteca.R.play() })
  await espera(900)
  const yAntes = await enAudio(() => scrollY)
  // Hacia abajo si cabe (lee adelante), si no hacia arriba: lo bastante para sacar de la vista cómoda lo que suena.
  const dy = await enAudio(() => { const resto = document.documentElement.scrollHeight - innerHeight - scrollY; return resto >= 360 ? 360 : -Math.min(360, scrollY) })
  await deslizarConElDedo(dy)
  await espera(350 + 260 + 400) // fin del gesto + retraso de la píldora + su entrada
  const m1 = await muestraPalabra()
  await espera(3000)
  const m2 = await muestraPalabra()
  const pildora = await enAudio(() => { const v = document.querySelector('.volver-voz'); return { visible: !v.hidden && v.classList.contains('visible'), toca: getComputedStyle(v).pointerEvents } })
  ok('scroll con la mano detiene el seguimiento: la página no se mueve sola en 3 s', !m1.lleva && Math.abs(m2.y - m1.y) < 1 && Math.abs(m1.y - yAntes) > 200 && m2.activa > m1.activa, `dedo ${dy} px · scrollY ${yAntes}→${m1.y}→${m2.y} · palabras ${m1.activa}→${m2.activa}`)
  ok('terminado el gesto aparece «Volver a la voz» (y solo entonces recibe toques)', pildora.visible && pildora.toca === 'auto', JSON.stringify(pildora))
  await foto('04d-mano-pildora')
  await pagina.click('.volver-voz')
  await espera(700)
  const g3 = await geometria()
  const m3 = await muestraPalabra()
  ok('«Volver a la voz» retoma: la línea que suena vuelve a la banda', m3.lleva && (g3.enBanda || g3.tope) && (await pagina.isHidden('.volver-voz')), `lleva=${m3.lleva} top ${g3.top?.toFixed(1)} banda ${g3.banda.toFixed(1)} scrollY ${g3.y}`)
  await pagina.click('[data-accion="vel-hoja"]')
  const rejilla = await pagina.$$eval('.hoja .rejilla .chip', (e) => e.map((x) => x.textContent))
  ok('hoja con 0.75× a 3× en pasos de 0.25', rejilla.join(' ') === '0.75× 1× 1.25× 1.5× 1.75× 2× 2.25× 2.5× 2.75× 3×', rejilla.join(' '))
  await foto('06a-hoja-velocidad')
  await pagina.click('.hoja .chip[data-h="2.25"]')
  ok('2.25× (paso fino) se muestra encendido en el panel', (await pagina.textContent('[data-accion="vel-hoja"]')) === '2.25×')
  await pagina.click('[data-vel="2.5"]')
  const vel = await enAudio(() => { const au = document.getElementById('audio'); return { rate: au.playbackRate, pitch: au.preservesPitch ?? au.webkitPreservesPitch, valor: document.querySelector('.velocidades .on')?.textContent } })
  ok('2.5× con tono conservado', Math.abs(vel.rate - 2.5) < 0.01 && vel.pitch === true, `rate=${vel.rate} preservesPitch=${vel.pitch} etiqueta=${vel.valor}`)
  await enAudio(() => window.__audioteca.R.irA(1))
  await espera(1000) // transitorio del cambio de velocidad en WebKit
  const t0 = await enAudio(() => document.getElementById('audio').currentTime)
  const w0 = Date.now()
  await espera(3000)
  const sync = await enAudio(() => {
    const au = document.getElementById('audio')
    return { t: au.currentTime, s: Number(document.querySelector('.seg.activa')?.dataset.s), esperado: window.__audioteca.R.segmentoEn(au.currentTime), pos: window.__ms.posicion }
  })
  const ritmo = (sync.t - t0) / ((Date.now() - w0) / 1000)
  ok('a 2.5× el audio avanza ~2.5 s por segundo', ritmo > 1.9 && ritmo < 3.1, `ritmo medido ${ritmo.toFixed(2)}×`)
  ok('a 2.5× el resaltado sigue sincronizado con currentTime', sync.s === sync.esperado, `seg ${sync.s} = esperado ${sync.esperado} (t=${sync.t.toFixed(2)})`)
  ok('pantalla bloqueada recibe la velocidad (setPositionState.playbackRate)', sync.pos?.playbackRate === 2.5, JSON.stringify(sync.pos))
  // Fluidez medida (~8 s a 2.5×: el capítulo de prueba dura 25 s y no debe acabarse a media medición): cuadros del bucle del lector > 32 ms, movimientos de la caja y su desfase.
  await enAudio(() => window.__audioteca.R.irA(0.5))
  await espera(250)
  await enAudio(() => window.__lector.reiniciar())
  const k0 = (await muestraPalabra()).activa
  const desf = []
  for (let i = 0; i < 8; i++) { await espera(1000); const m = await muestraPalabra(); desf.push(m.activa - m.k) }
  const flu = await enAudio(() => window.__lector.medidas())
  const k1 = (await muestraPalabra()).activa
  const fluidez = { fecha: new Date().toISOString(), motor: motor.name(), velocidad: 2.5, ...flu, palabrasRecorridas: k1 - k0, desfases: desf, pctLentos: flu.cuadros ? +(100 * flu.lentos / flu.cuadros).toFixed(2) : null }
  writeFileSync(join(salida, 'fluidez.json'), JSON.stringify(fluidez, null, 2) + '\n')
  ok('fluidez a 2.5×: la caja se movió en cada palabra, en sincronía, y < 5 % de cuadros > 32 ms',
    flu.movimientos >= (k1 - k0) * 0.95 && k1 - k0 > 30 && desf.every((d) => Math.abs(d) <= 1) && fluidez.pctLentos < 5,
    `${flu.segundos.toFixed(1)} s · ${flu.cuadros} cuadros, ${flu.lentos} > 32 ms (peor ${flu.peorCuadro.toFixed(1)} ms) · ${flu.movimientos} movimientos de caja (${flu.saltos} saltos de línea) para ${k1 - k0} palabras · ${flu.deslizamientos} deslizamientos · trabajo máx ${flu.peorTrabajo.toFixed(2)} ms`)
  await foto('06-velocidad-2_5x')

  // 5. Toque en una palabra (con palabras; por oración se prueba en el segundo libro): el audio salta a su t0.
  await enAudio(() => document.getElementById('audio').pause())
  // Oración 5 (a media página): tras el toque queda audio de sobra para la Media Session y el −15 s de abajo.
  const objetivo = await pagina.$('.seg[data-s="5"] .w:nth-of-type(2)')
  const kObj = Number(await objetivo.getAttribute('data-w'))
  const t0Obj = await enAudio((k) => window.__lector.palabras()[k][0], kObj)
  await objetivo.click()
  const tras = await enAudio(() => ({ t: document.getElementById('audio').currentTime, activa: window.__lector.activa(), lleva: window.__lector.lleva(), s: Number(document.querySelector('.seg.activa')?.dataset.s), sonando: !document.getElementById('audio').paused }))
  ok('tocar una palabra salta el audio a su t0 (±0.25 s), la resalta y suena', Math.abs(tras.t - t0Obj) <= 0.25 && tras.activa === kObj && tras.lleva && tras.s === 5, `t=${tras.t.toFixed(3)} t0=${t0Obj} palabra ${tras.activa}/${kObj} oración ${tras.s}`)
  await pagina.waitForFunction(() => !document.getElementById('audio').paused, null, { timeout: 3000 }).catch(() => {})
  await foto('07-toque-palabra')
  // El capítulo de prueba es corto (25 s): en pausa no se acaba mientras se revisa la pantalla bloqueada.
  await enAudio(() => document.getElementById('audio').pause())

  // 6. Media Session
  const meta = await enAudio(() => ({ t: navigator.mediaSession?.metadata?.title, al: navigator.mediaSession?.metadata?.album, art: navigator.mediaSession?.metadata?.artwork?.length, acciones: Object.keys(window.__ms.handlers) }))
  ok('Media Session con título, libro y carátula', meta.t === 'La condición del hidalgo' && meta.al === 'Don Quijote de prueba' && meta.art >= 1, JSON.stringify(meta))
  ok('acciones de pantalla bloqueada', ['play', 'pause', 'seekbackward', 'seekforward', 'nexttrack', 'previoustrack', 'seekto'].every((x) => meta.acciones.includes(x)))
  const antes = await enAudio(() => document.getElementById('audio').currentTime)
  await enAudio(() => window.__ms.handlers.seekbackward({}))
  const despues = await enAudio(() => document.getElementById('audio').currentTime)
  ok('−15 s desde la pantalla bloqueada', antes - despues > 8, `${antes.toFixed(1)} → ${despues.toFixed(1)}`)
  await enAudio(() => window.__ms.handlers.nexttrack({}))
  await pagina.waitForFunction(() => window.__audioteca.R.estado.cap?.n === 2)
  await pagina.waitForFunction(() => location.hash.endsWith('/02'), null, { timeout: 5000 }).catch(() => {})
  const cap2 = await enAudio(() => ({ n: window.__audioteca.R.estado.cap.n, rate: document.getElementById('audio').playbackRate, hash: location.hash, title: navigator.mediaSession?.metadata?.title }))
  ok('siguiente capítulo desde la pantalla bloqueada conserva 2.5× y el lector lo acompaña', cap2.n === 2 && Math.abs(cap2.rate - 2.5) < 0.01 && cap2.hash.endsWith('/02'), JSON.stringify(cap2))
  await espera(1500)

  // 7. Posición y velocidad recordadas tras recargar; otro libro guarda la suya
  await enAudio(() => document.getElementById('audio').pause())
  await espera(300)
  const guardado = await enAudio(() => JSON.parse(localStorage.getItem('audioteca.progreso'))['prueba-audioteca'])
  await pagina.reload()
  await pagina.waitForSelector('.texto .seg')
  await pagina.click('[data-accion="play"]')
  await pagina.waitForFunction(() => document.getElementById('audio').currentTime > 0.5)
  const rest = await enAudio(() => ({ t: document.getElementById('audio').currentTime, rate: document.getElementById('audio').playbackRate, n: window.__audioteca.R.estado.cap.n }))
  ok('tras recargar retoma capítulo, posición y 2.5×', rest.n === guardado.cap && Math.abs(rest.t - guardado.t) < 2.5 && Math.abs(rest.rate - 2.5) < 0.01, `guardado cap ${guardado.cap} t=${guardado.t.toFixed(1)} → cap ${rest.n} t=${rest.t.toFixed(1)} ${rest.rate}×`)
  await enAudio(() => document.getElementById('audio').pause())
  await pagina.goto(BASE + '#/libro/prueba-dos')
  await pagina.click('[data-accion="principal"]')
  await pagina.waitForFunction(() => window.__audioteca.R.estado.libro?.slug === 'prueba-dos' && !document.getElementById('audio').paused)
  // Sin "palabras" (capítulo aún sin alinear): sigue por oración, como siempre.
  await pagina.waitForSelector('.texto .seg.activa', { timeout: 5000 }).catch(() => {})
  const sinPal = await enAudio(() => {
    const au = document.getElementById('audio'); const R = window.__audioteca.R
    return { clase: document.querySelector('.texto')?.classList.contains('por-palabra'), spans: document.querySelectorAll('.texto .w').length, cajas: document.querySelectorAll('.caja-palabra').length, s: Number(document.querySelector('.seg.activa')?.dataset.s), esperado: R.segmentoEn(au.currentTime), palabras: R.estado.cap.palabras?.length }
  })
  ok('sin "palabras" el lector sigue por oración (sin spans ni caja)', !sinPal.clase && sinPal.spans === 0 && sinPal.cajas === 0 && sinPal.s === sinPal.esperado && sinPal.palabras === 0, JSON.stringify(sinPal))
  const inicio3 = await enAudio(() => window.__audioteca.R.estado.cap.segmentos[3][0])
  await pagina.click('.seg[data-s="3"]')
  await espera(250)
  const tras3 = await enAudio(() => ({ t: document.getElementById('audio').currentTime, s: Number(document.querySelector('.seg.activa')?.dataset.s) }))
  ok('sin palabras, tocar una oración salta el audio ahí', tras3.s === 3 && tras3.t >= inicio3 - 0.1 && tras3.t < inicio3 + 1.5, `t=${tras3.t.toFixed(2)} inicio=${inicio3}`)
  await foto('07b-por-oracion-sin-palabras')
  await pagina.click('[data-vel="1.75"]')
  await enAudio(() => document.getElementById('audio').pause())
  await pagina.goto(BASE + '#/libro/prueba-audioteca')
  await pagina.click('[data-accion="principal"]')
  await pagina.waitForFunction(() => window.__audioteca.R.estado.libro?.slug === 'prueba-audioteca')
  const porLibro = await enAudio(() => ({ uno: document.getElementById('audio').playbackRate, dos: JSON.parse(localStorage.getItem('audioteca.progreso'))['prueba-dos'].vel }))
  ok('velocidad recordada por libro (2.5× aquí, 1.75× en el otro)', Math.abs(porLibro.uno - 2.5) < 0.01 && porLibro.dos === 1.75, JSON.stringify(porLibro))
  await enAudio(() => document.getElementById('audio').pause())

  // 8. Voces (10 nov: en el engrane de la ficha y en los ajustes del lector): elegir otra conservando la oración y pedir una nueva.
  await pagina.goto(BASE + '#/libro/prueba-audioteca')
  await pagina.click('.ficha [data-accion="ajustes"]')
  await pagina.waitForSelector('.hoja .voces-hoja .voz')
  const filas = await pagina.$$eval('.hoja .voz', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()))
  ok('engrane de la ficha: la voz del libro elegida, otra a medias y una para pedir', filas.length === 4 && /Lectora.*voz del libro.*2 de 3/.test(filas[0]) && /Lector .*1 de 3/.test(filas[1]) && /Trinity.*Pedir/.test(filas[2]) && /macOS.*Pedir/.test(filas[3]), filas.join(' | '))
  ok('la voz elegida está marcada en oro', (await pagina.textContent('.hoja .voz.on')).includes('Lectora'))
  await foto('12-voces-ficha')
  await pagina.click('#hoja', { position: { x: 20, y: 20 } })
  await pagina.click('.capitulo[data-cap="1"]')
  await pagina.waitForSelector('.texto .seg')
  await pagina.waitForFunction(() => !document.getElementById('audio').paused)
  // Voz y letra viven en UN botón de ajustes del lector.
  const barra = await pagina.$$eval('.lector-top .derecha .boton-icono', (b) => b.map((x) => x.dataset.accion))
  ok('barra del lector: sueño, ajustes y capítulos (voz y letra dentro de ajustes)', barra.join(',') === 'sueño,ajustes-lectura,capitulos', barra.join(','))
  // Panel plegable (11 nov): el asa lo pliega a una barra, se recuerda por orientación y en horizontal arranca plegado.
  const panelInfo = () => enAudio(() => { const el = document.querySelector('.panel'); return { plegado: el.classList.contains('plegado'), alto: el.offsetHeight, expandido: document.querySelector('.panel .asa').getAttribute('aria-expanded'), pref: JSON.parse(localStorage.getItem('audioteca.prefs') || '{}').panelPlegado } })
  const p0 = await panelInfo()
  await pagina.click('.panel .asa')
  await espera(700)
  const p1 = await panelInfo()
  ok('el asa pliega el panel a una barra y lo recuerda', !p0.plegado && p1.plegado && p1.alto < p0.alto * 0.6 && p1.expandido === 'false' && p1.pref?.retrato === true, `${p0.alto}px → ${p1.alto}px · ${JSON.stringify(p1.pref)}`)
  const vp = pagina.viewportSize()
  await pagina.setViewportSize({ width: vp.height, height: vp.width })
  await espera(500)
  await pagina.click('.compacto-info')
  await espera(700)
  const p2 = await panelInfo()
  await pagina.setViewportSize(vp)
  await espera(500)
  const p3 = await panelInfo()
  ok('cada orientación recuerda lo suyo (horizontal desplegado, vertical plegado)', !p2.plegado && p3.plegado && p2.pref?.paisaje === false, JSON.stringify(p3.pref))
  await pagina.click('.panel .asa')
  await espera(700)
  ok('el asa lo vuelve a desplegar', !(await panelInfo()).plegado)
  await pagina.click('[data-accion="ajustes-lectura"]')
  await pagina.waitForSelector('.hoja .fila-voz')
  const hojaAj = await enAudio(() => ({ h3: document.querySelector('.hoja h3')?.textContent, letra: !!document.querySelector('.hoja .letras [data-d="2"]'), voz: document.querySelector('.hoja .fila-voz')?.textContent.replace(/\s+/g, ' ').trim() }))
  ok('ajustes del lector abre «Ajustes de lectura» con tamaño de letra y la voz', hojaAj.h3 === 'Ajustes de lectura' && hojaAj.letra && /Voz de la narración.*Lectora/.test(hojaAj.voz), JSON.stringify(hojaAj))
  await foto('13a-ajustes-lectura')
  // A+: el texto crece y la caja se vuelve a medir sobre la misma palabra (ResizeObserver).
  await pagina.click('.hoja [data-d="2"]')
  await enAudio(() => document.getElementById('audio').pause())
  await espera(400)
  const g4 = await geometria()
  const letra = await enAudio(() => getComputedStyle(document.documentElement).getPropertyValue('--letra').trim())
  ok('A+ agranda la letra y la caja sigue cubriendo la palabra', letra === '22px' && g4.cubre, `--letra ${letra} · caja ${g4.caja} · span ${g4.span}`)
  await pagina.click('.hoja [data-d="-2"]')
  await enAudio(() => window.__audioteca.R.play())
  await pagina.click('#hoja', { position: { x: 20, y: 20 } }) // cierra la hoja tocando el velo
  await enAudio(() => window.__audioteca.R.irASegmento(9))
  await espera(400)
  const antesVoz = await enAudio(() => {
    const au = document.getElementById('audio'); const R = window.__audioteca.R
    return { t: au.currentTime, s: R.segmentoEn(au.currentTime), voz: R.estado.cap.voz, texto: document.querySelector('.seg.activa')?.textContent }
  })
  await pagina.click('[data-accion="ajustes-lectura"]')
  await pagina.waitForSelector('.hoja .fila-voz')
  await pagina.click('.hoja .fila-voz')
  await pagina.waitForSelector('.hoja [data-h="elegir:lector"]')
  await foto('13-hoja-voces')
  await pagina.click('.hoja [data-h="elegir:lector"]')
  await pagina.waitForFunction(() => window.__audioteca.R.estado.cap?.voz === 'lector' && !document.getElementById('audio').paused && document.querySelector('.seg.activa'), null, { timeout: 15000 })
  await espera(300)
  const trasVoz = await enAudio(() => {
    const au = document.getElementById('audio'); const R = window.__audioteca.R
    const s = R.segmentoEn(au.currentTime)
    return { t: au.currentTime, s, voz: R.estado.cap.voz, seg: R.estado.cap.segmentos[s], texto: document.querySelector('.seg.activa')?.textContent, rate: au.playbackRate, guardada: JSON.parse(localStorage.getItem('audioteca.progreso'))['prueba-audioteca'].voz }
  })
  ok('cambiar de voz sigue en la MISMA oración con la voz nueva (y conserva la velocidad)', trasVoz.voz === 'lector' && trasVoz.texto === antesVoz.texto && Math.abs(trasVoz.t - antesVoz.t) > 0.3 && Math.abs(trasVoz.rate - 2.5) < 0.01,
    `«${antesVoz.texto}» ${antesVoz.voz} t=${antesVoz.t.toFixed(2)} → ${trasVoz.voz} t=${trasVoz.t.toFixed(2)} [${trasVoz.seg}] «${trasVoz.texto}»`)
  ok('la voz elegida se guarda con el progreso del libro', trasVoz.guardada === 'lector')
  await foto('14-lector-otra-voz')
  await enAudio(() => document.getElementById('audio').pause())
  await pagina.goto(BASE + '#/libro/prueba-audioteca')
  await pagina.waitForSelector('.capitulo[data-cap="2"]')
  const filaCap2 = await pagina.textContent('.capitulo[data-cap="2"]')
  ok('capítulo que aún no está en la voz elegida suena en la del libro, y lo dice', /en voz de Lectora/.test(filaCap2), filaCap2.replace(/\s+/g, ' ').trim())
  await pagina.click('.ficha [data-accion="ajustes"]')
  await pagina.waitForSelector('.hoja [data-h="pedir:trinity-clon"]')
  ok('la voz nueva queda elegida en el engrane', (await pagina.textContent('.hoja .voz.on')).includes('Lector'))
  await pagina.click('.hoja [data-h="pedir:trinity-clon"]')
  await pagina.waitForSelector('.hoja [data-h="si"]')
  await foto('15-pedir-voz')
  await pagina.click('.hoja [data-h="si"]')
  await pagina.waitForFunction(() => document.getElementById('hoja').hidden, null, { timeout: 5000 })
  await espera(300)
  const pedidos = JSON.parse(readFileSync(join(narrador, 'pedidos.json'), 'utf8')).pedidos
  ok('pedir otra voz desde la app la agrega a la cola del narrador (pedidos.json)', pedidos.length === 1 && pedidos[0].slug === 'prueba-audioteca' && pedidos[0].voz === 'trinity-clon', JSON.stringify(pedidos))
  await foto('16-voz-pedida')
  // Regresa a la voz del libro para el resto del recorrido.
  await pagina.click('.ficha [data-accion="ajustes"]')
  await pagina.click('.hoja [data-h="elegir:lectora"]')
  await pagina.waitForFunction(() => JSON.parse(localStorage.getItem('audioteca.progreso'))['prueba-audioteca'].voz === 'lectora', null, { timeout: 5000 })

  // 9. Precarga del siguiente capítulo: el arranque de su audio queda en el service worker antes de que acabe este.
  await pagina.click('.capitulo[data-cap="1"]')
  await pagina.waitForFunction(() => !document.getElementById('audio').paused && window.__audioteca.R.estado.cap?.n === 1)
  await enAudio(() => { window.__audioteca.R.ponerPrecarga(48 * 1024); window.__audioteca.R.irA(window.__audioteca.R.duracion() - 6) })
  await pagina.waitForFunction(async () => (await (await caches.open('audioteca-precarga-v1')).keys()).some((k) => /\/audio\/lectora\/02\.mp3/.test(k.url)), null, { timeout: 10000, polling: 300 })
  ok('a 90 s del final se precarga el arranque del capítulo siguiente', true)
  const t0cambio = Date.now()
  await pagina.waitForFunction(() => window.__audioteca.R.estado.cap?.n === 2 && document.getElementById('audio').currentTime > 0.2 && !document.getElementById('audio').paused, null, { timeout: 20000 })
  const cambio = Date.now() - t0cambio
  await espera(4000)
  const sigue = await enAudio(() => ({ t: document.getElementById('audio').currentTime, buffered: document.getElementById('audio').buffered.length ? document.getElementById('audio').buffered.end(0) : 0 }))
  ok('el capítulo siguiente arranca solo desde la precarga y sigue más allá de lo precargado (48 KB ≈ 6 s)', sigue.t > 9, `cambio en ${cambio} ms (incluye lo que faltaba del cap. 1); t=${sigue.t.toFixed(1)} s, en búfer ${sigue.buffered.toFixed(1)} s`)
  await enAudio(() => document.getElementById('audio').pause())

  // 10. Capítulo solo-texto
  await pagina.goto(BASE + '#/leer/prueba-audioteca/03')
  await pagina.waitForSelector('.sin-audio')
  ok('capítulo sin narrar se lee sin reproductor', !(await pagina.$('.panel')))
  await foto('08-solo-texto')

  // 11. Biblioteca con «Continuar»
  await pagina.goto(BASE + '#/')
  await pagina.waitForSelector('.continuar')
  ok('biblioteca muestra «Continuar» con el último libro', (await pagina.textContent('.continuar h2')).includes('Don Quijote de prueba'))
  await foto('09-biblioteca-continuar')
  // El botón de «Continuar» sigue al reproductor (2 nov: sonaba y seguía mostrando play).
  await pagina.click('[data-continuar]')
  await pagina.waitForFunction(() => !document.getElementById('audio').paused)
  await pagina.waitForFunction(() => document.querySelector('[data-continuar]').getAttribute('aria-label') === 'Pausa', null, { timeout: 3000 }).catch(() => {})
  ok('«Continuar» muestra pausa mientras suena', (await pagina.getAttribute('[data-continuar]', 'aria-label')) === 'Pausa')
  await pagina.click('[data-continuar]')
  await pagina.waitForFunction(() => document.getElementById('audio').paused)
  await pagina.waitForFunction(() => document.querySelector('[data-continuar]').getAttribute('aria-label') === 'Reproducir', null, { timeout: 3000 }).catch(() => {})
  ok('«Continuar» vuelve a play al pausar', (await pagina.getAttribute('[data-continuar]', 'aria-label')) === 'Reproducir')

  // 12. Descarga y modo avión
  const sw = await pagina.evaluate(async () => { const r = await navigator.serviceWorker?.ready; return !!r?.active })
  ok('service worker activo', sw)
  await pagina.goto(BASE + '#/libro/prueba-audioteca')
  await pagina.click('[data-accion="descargar"]')
  await pagina.waitForSelector('[data-accion="descargado"]', { timeout: 20000 })
  ok('libro descargado al teléfono', true, await pagina.textContent('[data-accion="descargado"]'))
  await foto('10-descargado')
  await contexto.setOffline(true)
  await pagina.reload()
  await pagina.waitForSelector('.ficha .capitulos', { timeout: 10000 })
  ok('sin red: la app y la ficha abren desde el teléfono', true)
  const rango = await pagina.evaluate(async () => {
    const c = (await (await fetch('api/libros/prueba-audioteca')).json()).capitulos[0]
    const r = await fetch(`api/libros/prueba-audioteca/audio/${c.voz}/01.mp3?v=${c.v}`, { headers: { range: 'bytes=0-1' } })
    return { estado: r.status, rango: r.headers.get('content-range'), bytes: (await r.arrayBuffer()).byteLength }
  })
  ok('sin red: Range 206 servido por el service worker', rango.estado === 206 && rango.bytes === 2, JSON.stringify(rango))
  await pagina.click('.capitulo[data-cap="1"]')
  await pagina.waitForSelector('.texto .seg')
  const t1 = await enAudio(() => document.getElementById('audio').currentTime)
  await pagina.waitForFunction((t) => document.getElementById('audio').currentTime > t + 1.5 && !document.getElementById('audio').paused, t1, { timeout: 15000 })
  const off = await enAudio(() => ({ t: document.getElementById('audio').currentTime, s: Number(document.querySelector('.seg.activa')?.dataset.s), online: navigator.onLine }))
  ok('modo avión: el capítulo descargado suena y resalta', !off.online && off.s >= 0, JSON.stringify(off))
  const offW = await muestraPalabra()
  ok('modo avión: también palabra a palabra', Math.abs(offW.activa - offW.k) <= 1 && offW.activa >= 0, `palabra ${offW.activa} esperada ${offW.k} «${offW.texto}»`)
  await foto('11-offline-sonando')
  await contexto.setOffline(false)
  await enAudio(() => document.getElementById('audio').pause())

  // 13. Descargado ANTES de tener palabras: cuando el servidor ya las tiene, la copia del teléfono se actualiza sola.
  await pagina.goto(BASE + '#/libro/prueba-dos')
  await pagina.click('[data-accion="descargar"]')
  await pagina.waitForSelector('[data-accion="descargado"]', { timeout: 20000 })
  const enCache = () => enAudio(async () => {
    const c = await caches.open('audioteca-libros-v1')
    const k = (await c.keys()).find((x) => /\/prueba-dos\/capitulos\/01\?voz=/.test(x.url))
    return k ? { url: k.url, palabras: (await (await c.match(k)).json()).palabras?.length } : null
  })
  const antesPal = await enCache()
  cpSync(join(raiz, 'fixtures/palabras/prueba-audioteca'), join(datos, 'palabras/prueba-dos'), { recursive: true })
  await enAudio((u) => fetch(u, { credentials: 'same-origin' }).then((r) => r.json()), antesPal?.url)
  await pagina.waitForFunction(async () => {
    const c = await caches.open('audioteca-libros-v1')
    const k = (await c.keys()).find((x) => /\/prueba-dos\/capitulos\/01\?voz=/.test(x.url))
    return k && (await (await c.match(k)).json()).palabras?.length > 0
  }, null, { timeout: 5000, polling: 200 }).catch(() => {})
  const despuesPal = await enCache()
  ok('capítulo descargado sin palabras: con red se actualiza su copia con las palabras (offline también por palabra)', antesPal?.palabras === 0 && despuesPal?.palabras > 50, `${antesPal?.palabras} → ${despuesPal?.palabras} palabras en audioteca-libros-v1`)

  ok('sin errores de consola', errores.length === 0, errores.slice(0, 3).join(' | '))
} catch (e) {
  ok('recorrido completo sin excepciones', false, e.message.split('\n')[0])
  await foto('error').catch(() => {})
} finally {
  await navegador.close()
  servidor.close()
}
writeFileSync(join(salida, 'resultado.txt'), resultados.join('\n') + '\n')
console.log(`\n${resultados.length - fallos}/${resultados.length} verificaciones e2e en verde (${motor.name()})`)
process.exit(fallos ? 1 : 0)
