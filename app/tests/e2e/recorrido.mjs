// Recorrido e2e en WebKit con viewport de iPhone 15 Pro Max: login → biblioteca → libro → reproducir →
// leer sincronizado → velocidad (criterio duro) → toque-a-oración → Media Session → recarga → voces (elegir,
// cambiar conservando la oración, pedir otra) → precarga del siguiente capítulo → descarga → modo avión.
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

const servidor = crearServidor({
  puerto: 0, host: '127.0.0.1', libros, narrador, voces, datos: mkdtempSync(join(tmpdir(), 'audioteca-e2e-datos-')), prefijo: '/audioteca', cookieSegura: false,
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
const pagina = await contexto.newPage()
const errores = []
pagina.on('pageerror', (e) => errores.push(e.message))
pagina.on('console', (m) => { if (m.type() === 'error' && !/401|Failed to load resource/.test(m.text())) errores.push(m.text()) })
const foto = async (n) => { await espera(450); return pagina.screenshot({ path: join(salida, `${n}.png`) }) }
const enAudio = (fn) => pagina.evaluate(fn)

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
  await foto('06-velocidad-2_5x')

  // 5. Toque en una oración
  const objetivo = await pagina.$('.seg[data-s="9"]')
  const inicio9 = await enAudio(() => window.__audioteca.R.estado.cap.segmentos[9][0])
  await objetivo.click()
  await espera(250)
  const tras = await enAudio(() => ({ t: document.getElementById('audio').currentTime, s: Number(document.querySelector('.seg.activa')?.dataset.s) }))
  ok('tocar una oración salta el audio ahí', tras.s === 9 && tras.t >= inicio9 - 0.1 && tras.t < inicio9 + 1.5, `t=${tras.t.toFixed(2)} inicio=${inicio9}`)
  await foto('07-toque-oracion')

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
  await pagina.click('[data-vel="1.75"]')
  await enAudio(() => document.getElementById('audio').pause())
  await pagina.goto(BASE + '#/libro/prueba-audioteca')
  await pagina.click('[data-accion="principal"]')
  await pagina.waitForFunction(() => window.__audioteca.R.estado.libro?.slug === 'prueba-audioteca')
  const porLibro = await enAudio(() => ({ uno: document.getElementById('audio').playbackRate, dos: JSON.parse(localStorage.getItem('audioteca.progreso'))['prueba-dos'].vel }))
  ok('velocidad recordada por libro (2.5× aquí, 1.75× en el otro)', Math.abs(porLibro.uno - 2.5) < 0.01 && porLibro.dos === 1.75, JSON.stringify(porLibro))
  await enAudio(() => document.getElementById('audio').pause())

  // 8. Voces: la sección en la ficha, elegir otra conservando la oración, el botón del lector y pedir una nueva.
  await pagina.goto(BASE + '#/libro/prueba-audioteca')
  await pagina.waitForSelector('.voces .voz')
  const filas = await pagina.$$eval('.voces .voz', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()))
  ok('ficha con sección «Voces»: la del libro elegida, otra a medias y una para pedir', filas.length === 4 && /Lectora.*voz del libro.*2 de 3/.test(filas[0]) && /Lector .*1 de 3/.test(filas[1]) && /Trinity.*Pedir/.test(filas[2]) && /macOS.*Pedir/.test(filas[3]), filas.join(' | '))
  ok('la voz elegida está marcada en oro', await pagina.isVisible('.voz.on[data-voz="lectora"]'))
  await foto('12-voces-ficha')
  await pagina.click('.capitulo[data-cap="1"]')
  await pagina.waitForSelector('.texto .seg')
  await pagina.waitForFunction(() => !document.getElementById('audio').paused)
  await enAudio(() => window.__audioteca.R.irASegmento(9))
  await espera(400)
  const antesVoz = await enAudio(() => {
    const au = document.getElementById('audio'); const R = window.__audioteca.R
    return { t: au.currentTime, s: R.segmentoEn(au.currentTime), voz: R.estado.cap.voz, texto: document.querySelector('.seg.activa')?.textContent }
  })
  ok('botón de voz en el lector (el libro tiene 2 voces narradas)', await pagina.isVisible('[data-accion="voz"]'))
  await pagina.click('[data-accion="voz"]')
  await pagina.waitForSelector('.hoja [data-h="lector"]')
  await foto('13-hoja-voces')
  await pagina.click('.hoja [data-h="lector"]')
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
  await pagina.waitForSelector('.voz.on[data-voz="lector"]')
  const filaCap2 = await pagina.textContent('.capitulo[data-cap="2"]')
  ok('capítulo que aún no está en la voz elegida suena en la del libro, y lo dice', /en voz de Lectora/.test(filaCap2), filaCap2.replace(/\s+/g, ' ').trim())
  await pagina.click('.voz-pedir[data-voz="trinity-clon"]')
  await pagina.waitForSelector('.hoja [data-h="si"]')
  await foto('15-pedir-voz')
  await pagina.click('.hoja [data-h="si"]')
  await pagina.waitForFunction(() => /Pedida/.test(document.querySelector('.voz[data-voz], .voces li:last-child')?.closest('.voces')?.textContent || ''))
  const pedidos = JSON.parse(readFileSync(join(narrador, 'pedidos.json'), 'utf8')).pedidos
  ok('pedir otra voz desde la app la agrega a la cola del narrador (pedidos.json)', pedidos.length === 1 && pedidos[0].slug === 'prueba-audioteca' && pedidos[0].voz === 'trinity-clon', JSON.stringify(pedidos))
  await foto('16-voz-pedida')
  // Regresa a la voz del libro para el resto del recorrido.
  await pagina.click('.voz[data-voz="lectora"]')
  await pagina.waitForSelector('.voz.on[data-voz="lectora"]')

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
  await foto('11-offline-sonando')
  await contexto.setOffline(false)

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
