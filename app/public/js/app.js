// Audioteca — vistas y navegación. Hash router: #/ · #/libro/<slug> · #/leer/<slug>/<nn> · #/ajustes
import { api, rutas, SinSesion } from './api.js'
import * as R from './reproductor.js'
import { descargarLibro, descargaEnCurso, estadoDescargas, resumen, borrarLibro, inventario, migrarDescargasV1, CACHE_LIBROS } from './descargas.js'
import { portadaHtml, tonoDe } from './portadas.js'
import { prefs, guardarPref, progreso, progresos, ultimoLibro, fusionarProgresoRemoto, sincronizarPendientes, vozDe, VELOCIDADES } from './estado.js'
import { conVoz, vocesConAudio, nombreVoz, vozPorOmision } from './voces.js'
import { icono, esc, reloj, duracionHumana, velTexto, megas, avisar, nn, h } from './util.js'
import { cuerpoHtml, montarLector } from './lector-palabras.js'

// La app vive en una carpeta: sin barra final las rutas relativas apuntarían fuera.
if (!location.pathname.endsWith('/')) location.replace(location.pathname + '/' + location.search + location.hash)

const PRESETS = [1, 1.5, 1.75, 2, 2.5] // a un toque en el panel; el resto (0.75×–3× de 0.25 en 0.25) en la hoja
const vista = document.getElementById('vista')
const mini = document.getElementById('mini')
const hoja = document.getElementById('hoja')
let limpiarVista = () => {}
let librosCache = null
let turno = 0 // cada render tiene su turno; una vista que termina tarde no pisa a la más nueva
const vigente = (mio) => mio === turno

document.documentElement.style.setProperty('--letra', `${prefs().letra}px`)

// ── Service worker ───────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {})
}
migrarDescargasV1().catch(() => {})

// ── Router ───────────────────────────────────────────────────────────────
function ruta() {
  const partes = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
  return partes
}
export const ir = (hash, reemplazar = false) => {
  if (reemplazar) history.replaceState(null, '', hash)
  else if (location.hash !== hash) { location.hash = hash; return }
  render()
}

async function render() {
  limpiarVista()
  limpiarVista = () => {}
  // Red de seguridad: el panel del reproductor vive en <body>, fuera de #vista. Si una vista anterior falló a medio
  // montar, su panel se quedaba pegado encima de la siguiente (10 nov: la ficha con el panel del lector abajo).
  for (const sobrante of document.querySelectorAll('body > .panel')) sobrante.remove()
  cerrarHoja()
  const mio = ++turno
  const [seccion, a, b] = ruta()
  try {
    let limpiar
    if (seccion === 'libro' && a) limpiar = await vistaLibro(a, mio)
    else if (seccion === 'leer' && a && b) limpiar = await vistaLector(a, Number(b), mio)
    else if (seccion === 'ajustes') limpiar = await vistaAjustes(mio)
    else limpiar = await vistaBiblioteca(mio)
    if (!vigente(mio)) { limpiar?.(); return }
    limpiarVista = limpiar || limpiarVista
  } catch (e) {
    if (!vigente(mio)) return
    if (e instanceof SinSesion) return vistaEntrada()
    console.error(e)
    vista.innerHTML = `<div class="pagina"><div class="vacio">${esc(navigator.onLine ? e.message || 'Algo falló' : 'Sin conexión y sin copia en el teléfono.')}<br><br>
      <button class="boton vidrio titanio" style="padding:0 20px" data-accion="reintentar">Reintentar</button></div></div>`
    vista.querySelector('[data-accion="reintentar"]').onclick = render
  }
  pintarMini()
}
addEventListener('hashchange', render)

// ── Entrada (login) ──────────────────────────────────────────────────────
function vistaEntrada() {
  mini.hidden = true
  vista.innerHTML = `
    <div class="entrada"><form autocomplete="on">
      <div class="sello"><img src="iconos/icono.svg" alt=""></div>
      <h1>Audioteca</h1>
      <p>Escribe la contraseña de tu Audioteca</p>
      <input class="campo" name="usuario" type="text" autocomplete="username" value="audioteca" hidden>
      <input class="campo" name="contraseña" type="password" autocomplete="current-password" placeholder="Contraseña" required>
      <button class="boton oro" type="submit">Entrar</button>
      <div class="error" aria-live="assertive"></div>
    </form></div>`
  const form = vista.querySelector('form')
  form.onsubmit = async (ev) => {
    ev.preventDefault()
    const boton = form.querySelector('button')
    boton.disabled = true
    form.querySelector('.error').textContent = ''
    try {
      await api.entrar(form.contraseña.value)
      ir('#/', true)
    } catch (e) {
      form.querySelector('.error').textContent = e instanceof SinSesion ? 'Contraseña incorrecta' : e.message
    } finally {
      boton.disabled = false
    }
  }
}

// ── Biblioteca ───────────────────────────────────────────────────────────
function estadoLibro(l) {
  const total = typeof l.capitulos === 'number' ? l.capitulos : l.capitulos.length
  if (!total) return { clase: '', texto: l.estado === 'pendiente-traduccion' ? 'Traduciéndose' : 'En preparación' }
  if (l.narrados === total) return { clase: 'completo', texto: `Completo · ${duracionHumana(l.duracion)}` }
  if (l.narrados > 0) return { clase: 'narrando', texto: `Narrando · ${l.narrados} de ${total}` }
  return { clase: 'narrando', texto: `Texto listo · narración en cola` }
}

/** Cuándo quedó narrado completo (ms): la versión más nueva de sus capítulos (mtime en base 36). 0 si le falta alguno. */
function terminadoEn(l) {
  if (!l.capitulos || l.narrados !== l.capitulos || !l.versiones?.length) return 0
  return Math.max(...l.versiones.map(([, v]) => parseInt(v, 36) || 0))
}

/** Terminado en los últimos 3 días y sin abrir (con más, todo lo no abierto diría «Nuevo»). */
const esNuevo = (l) => !progreso(l.slug)?.ts && Date.now() - terminadoEn(l) < 3 * 864e5

function fraccionDe(libro, p) {
  if (!p || !libro.capitulos?.length) return 0
  if (p.fin) return 1
  let total = 0
  let hecho = 0
  for (const c of libro.capitulos) {
    total += c.duracion
    if (c.n < p.cap) hecho += c.duracion
  }
  return total ? Math.min(1, (hecho + (p.t || 0)) / total) : 0
}

/** ¿Está en el teléfono cada capítulo narrado, en la voz que va a sonar? (versiones: [n, v, voz]) */
async function descargadoCompleto(l) {
  if (typeof caches === 'undefined' || !l.versiones?.length) return false
  const porCap = new Map()
  for (const [n, v, voz] of l.versiones) (porCap.get(n) || porCap.set(n, {}).get(n))[voz] = v
  const elegida = vozDe(l.slug) || vozPorOmision(l)
  const cache = await caches.open(CACHE_LIBROS)
  for (const [n, vs] of porCap) {
    const voz = [elegida, l.voz, ...Object.keys(vs)].find((x) => x && vs[x])
    if (!(await cache.match(new URL(rutas.audio(l.slug, n, vs[voz], voz), location.href).href))) return false
  }
  return true
}

async function vistaBiblioteca(mio) {
  if (!librosCache) vista.innerHTML = `<div class="pagina"><div class="cabecera"><h1 class="titulo-grande">Audioteca</h1></div></div>`
  let pintado = ''
  // `datos` = copia local (primera pintura al instante); sin argumento = red. Solo repinta si algo cambió.
  const pintar = async (datos = null) => {
    const { libros } = datos || (await api.libros())
    const firma = JSON.stringify(libros) + JSON.stringify(progresos())
    if (firma === pintado) return
    pintado = firma
    librosCache = libros
    if (!vigente(mio)) return
    const progs = progresos()
    // Lo más reciente arriba: lo último que escuchaste o, si nunca lo abriste, cuándo terminó de narrarse. Sin esto un
    // libro recién terminado quedaba debajo de todos los ya empezados, fuera de la pantalla.
    const reciente = (l) => progs[l.slug]?.ts || terminadoEn(l)
    const orden = [...libros].sort((a, b) => reciente(b) - reciente(a) || b.narrados - a.narrados || a.titulo.localeCompare(b.titulo))
    const slugUltimo = ultimoLibro()
    const ultimo = libros.find((l) => l.slug === slugUltimo && l.narrados > 0)
    let continuar = ''
    if (ultimo) {
      const crudo = api.libroGuardado(ultimo.slug) || (await api.libro(ultimo.slug).catch(() => null))
      const ficha = crudo && conVoz(crudo, vozDe(ultimo.slug))
      if (!vigente(mio)) return
      const p = progreso(ultimo.slug)
      const cap = ficha?.capitulos.find((c) => c.n === p.cap)
      if (ficha && cap) {
        const vel = p.vel || prefs().ultimaVel
        const resto = ficha.capitulos.reduce((a, c) => a + (c.n > cap.n ? c.duracion : 0), Math.max(0, cap.duracion - (p.t || 0)))
        continuar = `
          <section class="continuar titanio" data-ir="#/leer/${esc(ultimo.slug)}/${cap.nn}">
            ${portadaHtml(ultimo)}
            <div style="min-width:0;position:relative">
              <div class="eti">Continuar</div>
              <h2>${esc(ultimo.titulo)}</h2>
              <div class="cap">${esc(cap.titulo)}</div>
              <div class="fila">
                <div style="flex:1;min-width:0">
                  <div class="barra"><i style="width:${(fraccionDe(ficha, p) * 100).toFixed(1)}%"></i></div>
                  <div class="resta num" style="margin-top:7px">${duracionHumana(resto / vel)} restantes · ${velTexto(vel)}</div>
                </div>
                <button class="play-redondo" data-continuar="${esc(ultimo.slug)}" aria-label="${sonandoLibro(ultimo.slug) ? 'Pausa' : 'Reproducir'}">${sonandoLibro(ultimo.slug) ? icono.pausa : icono.play}</button>
              </div>
            </div>
          </section>`
      }
    }
    const tomos = orden.map((l) => {
      const e = estadoLibro(l)
      const p = progs[l.slug]
      return `
        <a class="tomo" href="#/libro/${esc(l.slug)}" data-slug="${esc(l.slug)}" style="${l.capitulos ? '' : 'opacity:.55'}">
          <div style="position:relative">${portadaHtml(l)}<span class="insignia" hidden>${icono.descargado}</span></div>
          ${p ? `<div class="barra" data-fraccion="${esc(l.slug)}"><i style="width:0%"></i></div>` : ''}
          <h3>${esc(l.titulo)}</h3>
          <div class="autor">${esc(l.autor)}</div>
          ${p ? `<div class="avance-tomo num" data-avance="${esc(l.slug)}">${p.fin ? 'Terminado' : 'En curso'}</div>`
            : esNuevo(l) ? '<div class="avance-tomo nuevo">Nuevo</div>' : ''}
          <div class="estado ${e.clase}"><span class="punto"></span>${esc(e.texto)}</div>
        </a>`
    }).join('')
    vista.innerHTML = `
      <div class="pagina">
        <div class="cabecera"><h1 class="titulo-grande">Audio<em>teca</em></h1>
          <a class="boton-icono" href="#/ajustes" aria-label="Ajustes y descargas">${icono.ajustes}</a></div>
        ${continuar}
        ${libros.length ? `<div class="seccion">Tu biblioteca</div><div class="estante">${tomos}</div>`
          : `<div class="vacio">Todavía no hay libros.<br>El narrador de tu Mac los irá dejando aquí.</div>`}
      </div>`
    vista.querySelector('[data-ir]')?.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-continuar]')) return
      ir(ev.currentTarget.dataset.ir)
    })
    vista.querySelector('[data-continuar]')?.addEventListener('click', async (ev) => {
      ev.stopPropagation()
      const slug = ev.currentTarget.dataset.continuar
      if (R.estado.libro?.slug === slug) return R.alternar()
      const p = progreso(slug)
      await R.cargar(slug, p.cap, { reproducir: true }).catch((e) => avisar(e.message))
    })
    // Detalles que requieren más datos llegan después, sin bloquear la primera pintura.
    for (const l of libros) {
      descargadoCompleto(l).then((ok) => { const i = vista.querySelector(`[data-slug="${CSS.escape(l.slug)}"] .insignia`); if (i) i.hidden = !ok })
      const barra = vista.querySelector(`[data-fraccion="${CSS.escape(l.slug)}"] i`)
      if (barra) Promise.resolve(api.libroGuardado(l.slug) || api.libro(l.slug)).then((crudo) => {
        const f = conVoz(crudo, vozDe(l.slug))
        const p = progs[l.slug]
        const fr = fraccionDe(f, p)
        barra.style.width = `${(fr * 100).toFixed(1)}%`
        const resto = f.capitulos.reduce((a, c) => a + (c.n > p.cap ? c.duracion : c.n === p.cap ? Math.max(0, c.duracion - (p.t || 0)) : 0), 0) / (p.vel || prefs().ultimaVel)
        const t = vista.querySelector(`[data-avance="${CSS.escape(l.slug)}"]`)
        if (t && !p.fin) t.textContent = `${Math.round(fr * 100)}% · ${duracionHumana(resto)}`
      }).catch(() => {})
    }
  }
  const guardados = api.librosGuardados()
  if (guardados) {
    await pintar(guardados)
    pintar().catch((e) => { if (e instanceof SinSesion) vistaEntrada() })
  } else await pintar()
  fusionarProgresoRemoto().then((cambio) => { if (cambio) pintar().catch(() => {}) })
  sincronizarPendientes()
  // El botón de «Continuar» sigue al reproductor: sin esto se quedaba en play mientras el libro sonaba
  // (y como esa tarjeta oculta el mini, era el único botón a la vista; 2 nov).
  const pintarContinuar = () => {
    const b = vista.querySelector('[data-continuar]')
    if (!b) return
    const sonando = sonandoLibro(b.dataset.continuar)
    b.innerHTML = sonando ? icono.pausa : icono.play
    b.setAttribute('aria-label', sonando ? 'Pausa' : 'Reproducir')
  }
  const quitar = [R.on('estado', pintarContinuar), R.on('capitulo', pintarContinuar), refrescoPeriodico(pintar)]
  return () => quitar.forEach((q) => q())
}

const sonandoLibro = (slug) => R.estado.libro?.slug === slug && !R.elemento.paused

/** Mientras la vista está abierta, refresca al volver a la app y cada minuto: el narrador sigue trabajando. */
function refrescoPeriodico(pintar) {
  const alVolver = () => { if (!document.hidden) pintar().catch(() => {}) }
  document.addEventListener('visibilitychange', alVolver)
  const id = setInterval(() => { if (!document.hidden && navigator.onLine) pintar().catch(() => {}) }, 30000)
  return () => { document.removeEventListener('visibilitychange', alVolver); clearInterval(id) }
}

// ── Libro ────────────────────────────────────────────────────────────────
async function vistaLibro(slug, mio) {
  // Primera pintura con la copia local si la hay; la red llega con el primer refresco (abajo).
  const guardada = api.libroGuardado(slug)
  let ficha = guardada || (await api.libro(slug))
  let libro = conVoz(ficha, vozDe(slug))
  let descargas = await estadoDescargas(libro)
  if (!vigente(mio)) return null
  // Nada de esta vista pinta si ya no es la vigente (10 nov, el bug de «no se abre el lector»): con una descarga en
  // curso, su avance llamaba a pintar() y la ficha se escribía encima del lector recién abierto, con el panel del
  // lector pegado abajo. Lo mismo valía para el fin de la descarga y los eventos del reproductor.
  const pintar = () => { if (vigente(mio)) pintarFicha() }
  const pintarFicha = () => {
    const p = progreso(slug)
    const sonando = R.estado.libro?.slug === slug && R.estado.cap
    const actual = sonando ? R.estado.cap.n : p?.cap
    const res = resumen(libro, descargas)
    const enCurso = descargaEnCurso(slug)
    const primeroNarrado = libro.capitulos.find((c) => c.audio)
    const textoBoton = !libro.narrados ? 'Leer' : p && !p.fin ? 'Continuar' : 'Escuchar'
    let botonDescarga
    if (!libro.narrados) botonDescarga = `<button class="boton vidrio titanio" disabled>${icono.nube} Sin audio aún</button>`
    else if (enCurso) botonDescarga = `<button class="boton vidrio titanio" data-accion="cancelar"><span class="pct num">${Math.round(enCurso.progreso * 100)}%</span> Descargando</button>`
    else if (res.completo) botonDescarga = `<button class="boton vidrio titanio" data-accion="descargado">${icono.descargado} ${megas(res.bytes)}</button>`
    else {
      const faltan = libro.capitulos.filter((c) => c.audio && descargas[c.n] !== 'audio')
      const bytes = faltan.reduce((a, c) => a + c.bytes, 0)
      botonDescarga = `<button class="boton vidrio titanio" data-accion="descargar">${icono.descargar} ${res.listos ? `${faltan.length} nuevos` : 'Descargar'} <span class="pct num" style="font-weight:500">${megas(bytes)}</span></button>`
    }
    const caps = libro.capitulos.map((c) => {
      const clase = [c.n === actual ? 'actual' : '', p && c.n < p.cap ? 'oido' : '', !c.audio && !c.texto ? 'pendiente' : ''].join(' ')
      const d = descargas[c.n]
      const lado = c.n === actual && sonando
        ? `<span class="ecualizador ${R.elemento.paused ? 'pausado' : ''}"><i></i><i></i><i></i></span>`
        : d === 'audio' ? `<span class="ok" title="Descargado" style="color:var(--oro-suave)">${icono.descargado}</span>` : ''
      const sub = c.audio ? `${duracionHumana(c.duracion)}${c.n === actual && p?.t && !sonando ? ` · vas en ${reloj(p.t)}` : ''}${c.otraVoz ? ` · en voz de ${esc(nombreVoz(libro, c.voz))}` : ''}` : c.texto ? 'Solo texto · por narrar' : 'Pendiente'
      return `<li><button class="capitulo ${clase}" data-cap="${c.n}">
        <span class="n num">${c.n}</span>
        <span><div class="t">${esc(c.titulo)}</div><div class="s num">${c.audio ? icono.voz.replace('<svg', '<svg style="width:13px;height:13px"') : ''}${sub}</div></span>
        <span class="lado">${lado}</span></button></li>`
    }).join('')
    vista.innerHTML = `
      <div class="pagina ficha" style="--tono:${tonoDe(slug)}">
        <div class="ficha-fondo"></div>
        <div class="ficha-top"><a class="boton-icono" href="#/" aria-label="Biblioteca">${icono.atras}</a>
          ${(libro.voces || []).length ? `<button class="boton-icono" data-accion="ajustes" aria-label="Ajustes del libro: voz de la narración">${icono.ajustes}</button>` : ''}</div>
        <div class="ficha-cabeza">
          ${portadaHtml(libro)}
          <h1>${esc(libro.titulo)}</h1>
          ${libro.titulo_original ? `<div class="original">${esc(libro.titulo_original)}</div>` : ''}
          <div class="autor">${esc(libro.autor)}</div>
          <div class="meta num">
            <span>${libro.capitulos.length} capítulos</span>
            ${libro.narrados ? `<span>${duracionHumana(libro.duracion)}${libro.narrados < libro.capitulos.length ? ' narradas' : ''}</span>` : ''}
            <span class="estado ${estadoLibro(libro).clase}"><span class="punto"></span>${esc(estadoLibro(libro).texto)}</span>
          </div>
        </div>
        <div class="acciones">
          <button class="boton oro" data-accion="principal" ${!primeroNarrado && !libro.capitulos.length ? 'disabled' : ''}>${libro.narrados ? icono.play : icono.libro} ${textoBoton}</button>
          ${botonDescarga}
        </div>
        ${libro.nota ? `<p class="nota">${esc(libro.nota)}</p>` : ''}
        ${libro.glosario ? `<p style="margin:14px 2px 0"><button class="enlace-oro" data-accion="glosario">Glosario de la traducción →</button></p>` : ''}
        <div class="seccion">Capítulos</div>
        <ul class="capitulos">${caps}</ul>
      </div>`
  }
  pintar()
  // Una descarga que arrancó otra visita a esta ficha: su final repinta ESTA (la otra ya no es vigente y se quedaba
  // en «Descargando 100%»).
  descargaEnCurso(slug)?.promesa?.finally(async () => { descargas = await estadoDescargas(libro); pintar() }).catch(() => {})

  const actualizar = (nueva) => {
    ficha = nueva
    libro = conVoz(ficha, vozDe(slug))
    return estadoDescargas(libro).then((d) => { descargas = d; if (vigente(mio)) pintar() })
  }
  vista.onclick = async (ev) => {
    const b = ev.target.closest('[data-accion],[data-cap]')
    if (!b) return
    const accion = b.dataset.accion
    if (accion === 'ajustes') return hojaVoces(libro, actualizar)
    if (b.dataset.cap) {
      const c = libro.capitulos.find((x) => x.n === Number(b.dataset.cap))
      if (!c.texto && !c.audio) return avisar('Este capítulo todavía no está listo')
      if (c.audio && !(R.estado.libro?.slug === slug && R.estado.cap?.n === c.n)) {
        const p = progreso(slug)
        return abrirSonando(slug, c, { t: p?.cap === c.n ? p.t : 0, reproducir: true })
      } else if (c.audio) R.play()
      return ir(`#/leer/${encodeURIComponent(slug)}/${c.nn}`)
    }
    if (accion === 'principal') {
      const p = progreso(slug)
      const cap = libro.capitulos.find((c) => c.n === p?.cap && c.audio && !p.fin) || libro.capitulos.find((c) => c.audio)
      if (!cap) return ir(`#/leer/${encodeURIComponent(slug)}/${libro.capitulos.find((c) => c.texto)?.nn || '01'}`)
      if (!(R.estado.libro?.slug === slug && R.estado.cap?.n === cap.n)) return abrirSonando(slug, cap, { t: p?.fin ? 0 : null, reproducir: true })
      R.play()
      return ir(`#/leer/${encodeURIComponent(slug)}/${cap.nn}`)
    }
    if (accion === 'descargar') {
      descargarLibro(libro, { alAvanzar: () => pintarPct() })
        .then(async () => { descargas = await estadoDescargas(libro); pintar(); avisar('Listo para escucharlo sin conexión') })
        .catch(async (e) => { descargas = await estadoDescargas(libro); pintar(); if (e.name !== 'AbortError') avisar(e.message) })
      return pintar()
    }
    if (accion === 'cancelar') { descargaEnCurso(slug)?.abortar(); return }
    if (accion === 'descargado') {
      return abrirHoja(`<h3>${esc(libro.titulo)}</h3>
        <button class="opcion" data-h="borrar"><span class="peligro">Borrar del teléfono</span><span class="num">${megas(resumen(libro, descargas).bytes)}</span></button>
        <button class="opcion" data-h="cerrar">Cancelar</button>`, async (op) => {
        if (op === 'borrar') { await borrarLibro(slug); descargas = await estadoDescargas(libro); pintar(); avisar('Descarga borrada') }
      })
    }
    if (accion === 'glosario') {
      const md = await api.glosario(slug)
      return abrirHoja(`<h3>Glosario de la traducción</h3><div class="texto" style="padding:0 4px 10px;font-size:16px">${mdSencillo(md || 'Sin glosario')}</div>`)
    }
  }
  let ultimoPct = 0
  const pintarPct = () => {
    const el = vista.querySelector('[data-accion="cancelar"] .pct')
    const pct = Math.round((descargaEnCurso(slug)?.progreso || 0) * 100)
    if (el && pct !== ultimoPct) { el.textContent = `${pct}%`; ultimoPct = pct }
    else if (!el && descargaEnCurso(slug)) pintar()
  }
  const quitar = [R.on('capitulo', pintar), R.on('estado', pintar), R.on('voz', () => actualizar(ficha))]
  const refrescar = async () => {
    const nueva = await api.libro(slug, { fresca: true })
    if (JSON.stringify(nueva) !== JSON.stringify(ficha)) await actualizar(nueva)
  }
  if (guardada) refrescar().catch(() => {})
  const refresco = refrescoPeriodico(refrescar)
  return () => { quitar.forEach((q) => q()); refresco(); vista.onclick = null }
}

// ── Voces ────────────────────────────────────────────────────────────────
function estadoVoz(v, libro) {
  const caps = v.narrando.map((x) => `${x.capitulo}${x.pct != null ? ` (${x.pct}%)` : ''}`)
  const narrando = caps.length ? `narrando cap. ${caps.join(' y ')}` : ''
  if (v.completa) return `Completa · ${duracionHumana(v.duracion)}`
  if (v.narrados) return `${v.narrados} de ${v.total} capítulos${narrando ? ` · ${narrando}` : v.enCola ? ' · en cola' : ''}`
  if (narrando) return narrando.charAt(0).toUpperCase() + narrando.slice(1)
  if (v.pedida) return 'Pedida · primero el capítulo 1 como muestra'
  if (v.enCola) return 'En la cola del narrador'
  if (v.pedible) return 'Puedes pedirla a tu Mac'
  return v.disponible ? libro.motivo || 'No disponible para este libro' : 'Ya no está en tu Mac'
}

/**
 * Voz de la narración, en una hoja: el engrane de la ficha y la fila «Voz» de los ajustes del lector la abren. Antes era
 * la sección «Voces» al pie de la ficha. Elegir una voz que ya tiene audio, pedir otra a tu Mac o cancelar un pedido. `actualizar` repinta la ficha.
 */
function hojaVoces(libro, actualizar = async () => {}) {
  const voces = libro.voces || []
  if (!voces.length) return avisar('Este libro todavía no tiene voces')
  const elegida = libro.vozElegida
  const filas = voces.map((v) => {
    const on = v.id === elegida && v.narrados > 0
    let accion = null
    let lado = ''
    if (on) lado = `<span class="voz-ok" aria-label="Elegida">${icono.descargado}</span>`
    else if (v.narrados) { accion = 'elegir'; lado = '<span class="voz-elegir">Elegir</span>' }
    else if (v.pedible) { accion = 'pedir'; lado = '<span class="chip voz-pedir">Pedir</span>' }
    else if (v.pedida && !v.narrando.length) { accion = 'cancelar-voz'; lado = '<span class="chip">Cancelar</span>' }
    const avance = v.total ? Math.round((100 * v.narrados) / v.total) : 0
    const tag = accion ? 'button' : 'div'
    return `<li><${tag} class="voz ${on ? 'on' : ''} ${accion ? 'elegible' : ''}" ${accion ? `data-h="${accion}:${esc(v.id)}"` : ''}>
      <span class="voz-sello" aria-hidden="true">${esc(v.nombre.charAt(0))}</span>
      <span class="voz-cuerpo"><span class="t">${esc(v.nombre)}${v.principal ? ' <small>· voz del libro</small>' : ''}</span>
        <span class="s num">${esc(estadoVoz(v, libro))}</span>
        ${v.narrados && !v.completa ? `<span class="voz-barra"><i style="width:${avance}%"></i></span>` : ''}</span>
      <span class="lado">${lado}</span></${tag}></li>`
  }).join('')
  abrirHoja(`<h3>Voz de la narración</h3><ul class="voces voces-hoja">${filas}</ul>
    <p class="hoja-texto" style="text-align:center;margin-top:14px">Al cambiar de voz sigue en la misma oración. Lo que pidas lo narra tu Mac, primero el capítulo 1 como muestra.</p>`, (op) => {
    const i = op.indexOf(':')
    if (i > 0) return accionVoz(libro, op.slice(i + 1), op.slice(0, i), actualizar)
  })
}

/**
 * Carga un capítulo y abre el lector en cuanto el reproductor lo tiene (su evento «capitulo»), sin esperar a que el
 * audio empiece a sonar: por Funnel y datos, esperar el play() dejaba el toque sin respuesta varios segundos. Si algo
 * falla antes del evento, abre igual a los 2.5 s (el lector muestra el texto y el aviso dice qué pasó).
 */
async function abrirSonando(slug, cap, opciones) {
  const mio = turno // si te vas a otra vista antes de que cargue, no se te regresa al lector
  let fin = () => {}
  const listo = new Promise((resolver) => {
    let quitar = () => {}
    const espera = setTimeout(() => fin(), 2500)
    fin = () => { quitar(); clearTimeout(espera); resolver() }
    quitar = R.on('capitulo', () => { if (R.estado.libro?.slug === slug && R.estado.cap?.n === cap.n) fin() })
  })
  R.cargar(slug, cap.n, opciones).catch((e) => { avisar(e.message); fin() })
  await listo
  if (turno === mio) ir(`#/leer/${encodeURIComponent(slug)}/${cap.nn}`)
}

async function accionVoz(libro, voz, accion, actualizar) {
  const v = (libro.voces || []).find((x) => x.id === voz)
  if (!v) return
  try {
    if (accion === 'elegir') {
      if (voz === libro.vozElegida) return
      await R.cambiarVoz(libro.slug, voz)
      await actualizar(await api.libro(libro.slug))
      return avisar(`Ahora suena con la voz de ${v.nombre}`)
    }
    if (accion === 'cancelar-voz') return actualizar(await api.cancelarVoz(libro.slug, voz)).then(() => avisar('Pedido cancelado'))
    if (accion === 'pedir') {
      const primero = libro.capitulos.find((c) => c.texto)
      abrirHoja(`<h3>${esc(libro.titulo)} en la voz de ${esc(v.nombre)}</h3>
        <p class="hoja-texto">Tu Mac narra primero <b>${esc(primero?.titulo || 'el capítulo 1')}</b> como muestra, antes que lo demás de la cola, y el resto del libro cuando termine lo que ya está en cola. La verás en el engrane del libro, en «Voz de la narración».</p>
        <button class="opcion oro-texto" data-h="si">Pedir esta voz</button>
        <button class="opcion" data-h="no">Cancelar</button>`, async (op) => {
        if (op !== 'si') return
        try { await actualizar(await api.pedirVoz(libro.slug, voz)); avisar(`Pedida: ${v.nombre}`) } catch (e) { avisar(e.message) }
      })
    }
  } catch (e) {
    if (e instanceof SinSesion) return vistaEntrada()
    avisar(navigator.onLine ? e.message : 'Sin conexión: inténtalo con red')
  }
}

function mdSencillo(md) {
  const lineas = md.split('\n')
  let html = ''
  let tabla = []
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<em>$1</em>').replace(/`(.+?)`/g, '<em>$1</em>')
  const cerrarTabla = () => {
    if (!tabla.length) return
    html += tabla.filter((f) => !/^\|?\s*:?-+/.test(f)).map((f, i) => {
      const celdas = f.replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()))
      return `<p style="margin:0 0 .7em;${i === 0 ? 'color:var(--oro-suave);font-weight:600' : ''}">${celdas[0]} → ${celdas.slice(1).join(' · ')}</p>`
    }).join('')
    tabla = []
  }
  for (const l of lineas) {
    if (l.trim().startsWith('|')) { tabla.push(l.trim()); continue }
    cerrarTabla()
    if (/^#{1,6}\s/.test(l)) html += `<h2>${inline(l.replace(/^#+\s*/, ''))}</h2>`
    else if (/^\s*[-*]\s/.test(l)) html += `<p class="li">${inline(l.replace(/^\s*[-*]\s/, ''))}</p>`
    else if (l.trim()) html += `<p>${inline(l)}</p>`
  }
  cerrarTabla()
  return html
}

// ── Lector + reproductor ─────────────────────────────────────────────────
async function vistaLector(slug, n, mio) {
  // Si ese capítulo es el que suena, el texto va alineado con su voz; si no, con la voz elegida del libro.
  const sonandoAqui = R.estado.libro?.slug === slug && R.estado.cap?.n === n
  const libro = sonandoAqui ? R.estado.libro : conVoz(api.libroGuardado(slug) || (await api.libro(slug)), vozDe(slug))
  const capFicha = libro.capitulos.find((c) => c.n === n)
  const voz = sonandoAqui ? R.estado.cap.voz : capFicha?.audio ? capFicha.voz : null
  const cap = await api.capitulo(slug, n, voz, sonandoAqui ? R.estado.cap.v : capFicha?.v || '')
  if (!vigente(mio)) return null
  const vinculado = () => R.estado.libro?.slug === slug && R.estado.cap?.n === cap.n && R.estado.cap?.voz === cap.voz
  // Palabra a palabra si el capítulo ya tiene tiempos por palabra; si no, por oración como siempre.
  const cuerpo = cuerpoHtml(cap.bloques, cap.audio ? cap.palabras || [] : [])
  const vecinos = { ant: libro.capitulos.filter((c) => c.n < cap.n && (c.texto || c.audio)).pop(), sig: libro.capitulos.find((c) => c.n > cap.n && (c.texto || c.audio)) }

  vista.innerHTML = `
    <div class="lector">
      <div class="lector-top">
        <a class="boton-icono" href="#/libro/${esc(slug)}" aria-label="Volver al libro">${icono.abajo}</a>
        <div class="donde"><b>${esc(libro.titulo)}</b><span class="num">Capítulo ${cap.n} de ${libro.capitulos.length}</span></div>
        <div class="derecha">
          ${cap.audio ? `<button class="boton-icono" data-accion="sueño" aria-label="Temporizador de sueño">${icono.luna}</button>` : ''}
          <button class="boton-icono" data-accion="ajustes-lectura" aria-label="Ajustes de lectura: letra y voz">${icono.ajustes}</button>
          <button class="boton-icono" data-accion="capitulos" aria-label="Capítulos">${icono.lista}</button>
        </div>
      </div>
      ${cap.audio ? '' : `<div class="sin-audio titanio" style="margin:6px 20px 18px">${icono.voz}<span>Este capítulo aún no está narrado. Puedes leerlo mientras tu Mac le pone voz.</span></div>`}
      <article class="texto" lang="es">${cuerpo}
        <nav class="fin-capitulo">
          ${vecinos.ant ? `<a class="boton vidrio titanio" href="#/leer/${esc(slug)}/${vecinos.ant.nn}">${icono.atras} Anterior</a>` : '<span></span>'}
          ${vecinos.sig ? `<a class="boton vidrio titanio" href="#/leer/${esc(slug)}/${vecinos.sig.nn}">Siguiente <span style="transform:scaleX(-1);display:inline-flex">${icono.atras}</span></a>` : '<span></span>'}
        </nav>
      </article>
      <button class="volver-voz" hidden>${icono.voz} Volver a la voz</button>
    </div>`
  scrollTo(0, 0)

  const texto = vista.querySelector('.texto')
  const volver = vista.querySelector('.volver-voz')

  // Panel del reproductor (solo si el capítulo tiene voz).
  let panel = null
  const quitar = []
  if (cap.audio) {
    panel = construirPanel(libro, cap, vinculado)
    document.body.appendChild(panel.el)
    quitar.push(() => panel.el.remove(), ...panel.quitar)
  } else {
    document.documentElement.style.setProperty('--panel-alto', '0px')
  }

  // Resaltado (palabra a palabra, o por oración sin tiempos por palabra) y quién lleva el scroll: lector-palabras.js.
  const lector = montarLector({
    texto, volver, cap, vinculado,
    barra: vista.querySelector('.lector-top'),
    altoPanel: () => panel?.alto() || 0,
    tInicial: progreso(slug)?.cap === cap.n ? progreso(slug).t : 0,
    // Tocar una palabra ({t}) o una oración ({s}): si este capítulo no es el que suena, lo carga ahí.
    alTocar: async ({ t, s }) => {
      if (vinculado() && s != null) return R.irASegmento(s)
      await R.cargar(slug, cap.n, { t: t ?? cap.segmentos[s][0], reproducir: true }).catch((e) => avisar(e.message))
    },
  })
  quitar.push(lector.limpiar)
  const ponerSonando = () => texto.classList.toggle('sonando', vinculado() && !R.elemento.paused)
  let capDelReproductor = R.estado.libro?.slug === slug ? R.estado.cap?.n : null
  quitar.push(R.on('capitulo', () => {
    // El reproductor cambió de capítulo (fin del anterior, audífonos, pantalla bloqueada): si este lector
    // mostraba el que sonaba y seguía la voz, lo acompaña.
    const ibaConLaVoz = capDelReproductor === cap.n && lector.lleva()
    capDelReproductor = R.estado.libro?.slug === slug ? R.estado.cap?.n : null
    if (ibaConLaVoz && capDelReproductor && capDelReproductor !== cap.n) return ir(`#/leer/${encodeURIComponent(slug)}/${R.estado.cap.nn}`, true)
    // Cambió la voz de este capítulo: otro texto alineado (otros segmentos), se vuelve a pintar.
    if (capDelReproductor === cap.n && R.estado.cap?.voz && R.estado.cap.voz !== cap.voz) return ir(`#/leer/${encodeURIComponent(slug)}/${cap.nn}`, true)
    ponerSonando()
  }))

  // Ajustes de lectura: la letra y, si hay más de una voz narrada, la voz (con la que suena este capítulo).
  vista.querySelector('[data-accion="ajustes-lectura"]').onclick = () => {
    const delLibro = R.estado.libro?.slug === slug ? R.estado.libro : libro
    const vozAhora = vinculado() ? R.estado.cap.voz : cap.voz
    hojaLetra(cap.audio && vocesConAudio(delLibro).length > 1 ? { libro: delLibro, nombre: nombreVoz(delLibro, vozAhora) } : null)
  }
  const botonSueño = vista.querySelector('[data-accion="sueño"]')
  if (botonSueño) {
    const pintarSueño = () => {
      const s = R.estado.sueño
      botonSueño.classList.toggle('sueño-activo', !!s)
      botonSueño.innerHTML = icono.luna + (s ? `<span class="etiqueta-sueño num">${s.finCapitulo ? 'cap' : Math.max(1, Math.ceil((s.fin - Date.now()) / 60000)) + 'm'}</span>` : '')
    }
    botonSueño.onclick = hojaSueño
    pintarSueño()
    const id = setInterval(pintarSueño, 20000)
    quitar.push(R.on('sueño', pintarSueño), () => clearInterval(id))
  }
  vista.querySelector('[data-accion="capitulos"]').onclick = () => hojaCapitulos(libro, cap.n)
  return () => quitar.forEach((q) => q())
}

function construirPanel(libro, cap, vinculado) {
  const el = h(`
    <section class="panel titanio" aria-label="Reproductor">
      <button class="asa" data-accion="plegar" aria-controls="panel-controles" aria-expanded="true" aria-label="Plegar el reproductor">
        <span class="tirador" aria-hidden="true"></span><span class="flecha" aria-hidden="true">${icono.abajo}</span></button>
      <div class="hilo-panel" aria-hidden="true"><i></i></div>
      <div class="panel-interior" id="panel-controles">
        <div class="avance" role="slider" aria-label="Posición" tabindex="0"><div class="riel"><div class="cargado"></div><div class="lleno"></div><div class="perilla"></div></div></div>
        <div class="tiempos num"><span data-t="actual">0:00</span><span data-t="capitulo"></span><span data-t="resto">-0:00</span></div>
        <div class="transporte">
          <button class="boton-icono cap-btn" data-accion="anterior" aria-label="Capítulo anterior">${icono.anterior}</button>
          <button class="boton-icono salto" data-accion="atras" aria-label="Atrás 15 segundos">${icono.menos15}<small>15</small></button>
          <button class="play-redondo" data-accion="play" aria-label="Reproducir">${icono.play}</button>
          <button class="boton-icono salto" data-accion="adelante" aria-label="Adelante 30 segundos">${icono.mas30}<small>30</small></button>
          <button class="boton-icono cap-btn" data-accion="siguiente" aria-label="Capítulo siguiente">${icono.siguiente}</button>
        </div>
        <div class="extra">
          <div class="velocidades" role="group" aria-label="Velocidad de lectura">
            ${PRESETS.map((v) => `<button class="chip num" data-vel="${v}">${velTexto(v)}</button>`).join('')}
            <button class="chip num mas" data-accion="vel-hoja" aria-label="Más velocidades">···</button>
          </div>
        </div>
        <div class="compacto">
          <button class="play-redondo" data-accion="play" aria-label="Reproducir">${icono.play}</button>
          <button class="compacto-info" data-accion="desplegar" aria-label="Desplegar el reproductor">
            <b class="num" data-t="resto-c">-0:00</b><span data-t="cap-c">${esc(cap.titulo)}</span></button>
          <button class="chip num" data-accion="vel-hoja" data-t="vel-c" aria-label="Velocidad">1×</button>
          <button class="boton-icono salto" data-accion="atras" aria-label="Atrás 15 segundos">${icono.menos15}<small>15</small></button>
          <button class="boton-icono salto" data-accion="adelante" aria-label="Adelante 30 segundos">${icono.mas30}<small>30</small></button>
        </div>
      </div>
    </section>`)
  const $ = (s) => el.querySelector(s)
  const avance = $('.avance')
  let arrastrando = null

  const pintarTiempo = () => {
    const v = vinculado()
    const t = v ? R.tiempos() : { t: progreso(libro.slug)?.cap === cap.n ? progreso(libro.slug).t : 0, dur: cap.duracion, vel: R.velocidad() }
    const dur = t.dur || cap.duracion || 0
    const actual = arrastrando ?? t.t
    const f = dur ? Math.min(1, actual / dur) : 0
    $('.lleno').style.width = `${f * 100}%`
    $('.perilla').style.left = `${f * 100}%`
    $('[data-t="actual"]').textContent = reloj(actual)
    $('[data-t="resto"]').textContent = `-${reloj(Math.max(0, dur - actual) / R.velocidad())}`
    $('[data-t="resto-c"]').textContent = `-${reloj(Math.max(0, dur - actual) / R.velocidad())}`
    $('.hilo-panel i').style.width = `${f * 100}%`
    $('[data-t="capitulo"]').textContent = v && t.restoLibro ? `${duracionHumana(t.restoLibro)} ${libro.narrados < libro.capitulos.length ? 'narrados por oír' : 'del libro'}` : ''
    avance.setAttribute('aria-valuenow', Math.round(actual))
    avance.setAttribute('aria-valuemax', Math.round(dur))
    const b = R.elemento.buffered
    if (v && b.length && dur) $('.cargado').style.width = `${Math.min(100, (b.end(b.length - 1) / dur) * 100)}%`
  }
  const pintarEstado = () => {
    const sonando = vinculado() && !R.elemento.paused
    for (const b of el.querySelectorAll('[data-accion="play"]')) {
      b.innerHTML = sonando ? icono.pausa : icono.play
      b.setAttribute('aria-label', sonando ? 'Pausa' : 'Reproducir')
    }
    $('[data-accion="anterior"]').disabled = !libro.capitulos.some((c) => c.audio && c.n < cap.n) && !vinculado()
    $('[data-accion="siguiente"]').disabled = !libro.capitulos.some((c) => c.audio && c.n > cap.n)
  }
  const pintarVel = () => {
    const v = vinculado() ? R.velocidad() : velocidadDeLibro()
    for (const c of el.querySelectorAll('[data-vel]')) c.classList.toggle('on', Number(c.dataset.vel) === v)
    // Si la velocidad no es un preset (p. ej. 2.25×), el último chip la muestra encendida.
    const otra = !PRESETS.includes(v)
    const mas = $('[data-accion="vel-hoja"]')
    mas.classList.toggle('on', otra)
    mas.textContent = otra ? velTexto(v) : '···'
    $('[data-t="vel-c"]').textContent = velTexto(v)
  }
  const velocidadDeLibro = () => { const p = progreso(libro.slug); return p?.vel || prefs().ultimaVel }
  const asegurar = async () => {
    if (vinculado()) return true
    await R.cargar(libro.slug, cap.n, { reproducir: true }).catch((e) => avisar(e.message))
    return false
  }
  el.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-accion],[data-vel]')
    if (!b) return
    if (b.dataset.vel) {
      if (!vinculado()) await R.cargar(libro.slug, cap.n).catch(() => {})
      R.ponerVelocidad(Number(b.dataset.vel))
      return
    }
    switch (b.dataset.accion) {
      case 'play': if (await asegurar()) R.alternar(); break
      case 'atras': if (await asegurar()) R.atras(); break
      case 'adelante': if (await asegurar()) R.adelante(); break
      case 'anterior': if (vinculado()) R.capituloAnterior(); break
      case 'siguiente':
        if (vinculado()) await R.capituloSiguiente()
        else { const s = libro.capitulos.find((c) => c.audio && c.n > cap.n); if (s) ir(`#/leer/${encodeURIComponent(libro.slug)}/${s.nn}`) }
        break
      case 'vel-hoja': hojaVelocidad(async () => { if (!vinculado()) await R.cargar(libro.slug, cap.n).catch(() => {}) }); break
      case 'plegar': if (!asa.arrastro) plegar(!el.classList.contains('plegado')); break
      case 'desplegar': plegar(false); break
    }
  })

  // ── Plegar el panel: un asa que lo baja hasta el fondo para ahorrar espacio.
  // Como el mini reproductor de Apple Music: el asa de arriba pliega/despliega con un toque o arrastrándola, y plegado
  // queda una barra con play, lo que resta, la velocidad y ±15/30. Se recuerda por orientación: en horizontal el alto
  // es lo que falta, así que ahí arranca plegado.
  const asa = $('.asa')
  const horizontal = matchMedia('(orientation: landscape)')
  const llave = () => (horizontal.matches ? 'paisaje' : 'retrato')
  const plegadoGuardado = () => { const g = prefs().panelPlegado || {}; return g[llave()] ?? llave() === 'paisaje' }
  let animandoAlto = false
  const aplicar = (plegado, animar) => {
    if (el.classList.contains('plegado') === plegado) return
    const antes = el.offsetHeight
    el.classList.toggle('plegado', plegado)
    asa.setAttribute('aria-expanded', String(!plegado))
    asa.setAttribute('aria-label', plegado ? 'Desplegar el reproductor' : 'Plegar el reproductor')
    asa.querySelector('.flecha').style.transform = plegado ? 'rotate(180deg)' : ''
    const despues = el.offsetHeight
    if (!animar || matchMedia('(prefers-reduced-motion: reduce)').matches || typeof el.animate !== 'function') return requestAnimationFrame(() => medir())
    // El alto se anima de una vez y el texto se acomoda al final (si no, el lector re-centraría cada cuadro).
    animandoAlto = true
    const a = el.animate([{ height: `${antes}px` }, { height: `${despues}px` }], { duration: 240, easing: 'cubic-bezier(.2,.8,.2,1)' })
    el.style.overflow = 'hidden'
    a.onfinish = a.oncancel = () => { el.style.overflow = ''; animandoAlto = false; medir() }
  }
  const plegar = (plegado) => {
    aplicar(plegado, true)
    guardarPref('panelPlegado', { ...(prefs().panelPlegado || {}), [llave()]: plegado })
  }
  aplicar(plegadoGuardado(), false)
  const alGirar = () => aplicar(plegadoGuardado(), false)
  horizontal.addEventListener('change', alGirar)
  // Arrastrar el asa: hacia abajo pliega, hacia arriba despliega (el toque solo lo resuelve el click).
  let yAsa = null
  asa.addEventListener('pointerdown', (ev) => { yAsa = ev.clientY; asa.arrastro = false; asa.setPointerCapture(ev.pointerId) })
  asa.addEventListener('pointermove', (ev) => {
    if (yAsa === null) return
    const dy = ev.clientY - yAsa
    if (Math.abs(dy) < 24) return
    asa.arrastro = true
    yAsa = null
    plegar(dy > 0)
  })
  const soltarAsa = () => { yAsa = null; setTimeout(() => { asa.arrastro = false }, 0) }
  asa.addEventListener('pointerup', soltarAsa)
  asa.addEventListener('pointercancel', soltarAsa)

  // Arrastrar la barra: se previsualiza el tiempo y se busca al soltar.
  const fraccionDeEvento = (ev) => { const r = avance.getBoundingClientRect(); return Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)) }
  avance.addEventListener('pointerdown', (ev) => {
    avance.setPointerCapture(ev.pointerId)
    avance.classList.add('arrastrando')
    arrastrando = fraccionDeEvento(ev) * (R.duracion() || cap.duracion)
    pintarTiempo()
  })
  avance.addEventListener('pointermove', (ev) => { if (arrastrando !== null) { arrastrando = fraccionDeEvento(ev) * (R.duracion() || cap.duracion); pintarTiempo() } })
  const soltar = async () => {
    if (arrastrando === null) return
    const t = arrastrando
    arrastrando = null
    avance.classList.remove('arrastrando')
    if (vinculado()) R.irA(t)
    else await R.cargar(libro.slug, cap.n, { t, reproducir: true }).catch((e) => avisar(e.message))
    pintarTiempo()
  }
  avance.addEventListener('pointerup', soltar)
  avance.addEventListener('pointercancel', soltar)
  avance.addEventListener('keydown', (ev) => { if (ev.key === 'ArrowLeft') R.atras(); if (ev.key === 'ArrowRight') R.adelante() })

  const medir = () => { if (!animandoAlto) document.documentElement.style.setProperty('--panel-alto', `${el.offsetHeight}px`) }
  requestAnimationFrame(medir)
  const ro = new ResizeObserver(medir)
  ro.observe(el)

  pintarTiempo(); pintarEstado(); pintarVel()
  return {
    el,
    alto: () => el.offsetHeight,
    quitar: [
      R.on('tiempo', pintarTiempo), R.on('estado', () => { pintarEstado(); pintarTiempo() }), R.on('velocidad', () => { pintarVel(); pintarTiempo() }),
      R.on('capitulo', () => { pintarEstado(); pintarVel(); pintarTiempo() }),
      () => ro.disconnect(),
      () => horizontal.removeEventListener('change', alGirar),
    ],
  }
}

// ── Hojas ────────────────────────────────────────────────────────────────
let alElegir = null
function abrirHoja(html, fn = null) {
  hoja.innerHTML = `<div class="hoja titanio" role="dialog" aria-modal="true"><span class="tirador"></span>${html}</div>`
  hoja.hidden = false
  alElegir = fn
}
function cerrarHoja() { hoja.hidden = true; hoja.innerHTML = ''; alElegir = null }
hoja.addEventListener('click', async (ev) => {
  if (ev.target === hoja) return cerrarHoja()
  const b = ev.target.closest('[data-h]')
  if (!b) return
  const fn = alElegir
  if (b.dataset.h !== 'mantener') cerrarHoja()
  if (fn) await fn(b.dataset.h, b)
})

function hojaVelocidad(antes) {
  const pintar = () => {
    const v = R.velocidad()
    abrirHoja(`<h3>Velocidad de lectura</h3>
      <div class="rejilla">${VELOCIDADES.map((x) => `<button class="chip num ${x === v ? 'on' : ''}" data-h="${x}">${velTexto(x)}</button>`).join('')}</div>
      <p style="color:var(--muted);font-size:13px;text-align:center;margin:14px 0 0">Se guarda para este libro y conserva el tono de la voz.</p>`, async (op) => {
      await antes()
      R.ponerVelocidad(Number(op))
    })
  }
  pintar()
}

function hojaSueño() {
  const s = R.estado.sueño
  const ops = [['cap', 'Al terminar el capítulo'], ['5', '5 minutos'], ['15', '15 minutos'], ['30', '30 minutos'], ['45', '45 minutos'], ['60', '1 hora']]
  abrirHoja(`<h3>Temporizador de sueño</h3>
    ${ops.map(([k, t]) => `<button class="opcion" data-h="${k}">${t}</button>`).join('')}
    ${s ? '<button class="opcion" data-h="apagar"><span class="peligro">Apagar temporizador</span></button>' : ''}`, (op) => {
    if (op === 'apagar') R.ponerSueño(null)
    else R.ponerSueño(op === 'cap' ? 'cap' : Number(op))
    avisar(op === 'apagar' ? 'Temporizador apagado' : 'Temporizador listo')
  })
}

/** «Ajustes de lectura» del lector: tamaño de letra y, con `voz` ({ libro, nombre }), la fila que abre las voces. */
function hojaLetra(voz = null) {
  const pintar = () => {
    const l = prefs().letra
    abrirHoja(`<h3>Ajustes de lectura</h3>
      <div class="ajuste-titulo">Tamaño de letra</div>
      <div class="letras">
      <button class="chip" data-h="mantener" data-d="-2" ${l <= 15 ? 'disabled' : ''} aria-label="Letra más chica">A−</button>
      <span class="muestra" style="font-size:${l}px">Aa · ${l}</span>
      <button class="chip" data-h="mantener" data-d="2" ${l >= 30 ? 'disabled' : ''} aria-label="Letra más grande">A+</button></div>
      ${voz ? `<button class="opcion fila-voz" data-h="voz"><span>Voz de la narración</span><span class="valor">${esc(voz.nombre)} ›</span></button>` : ''}`, (op, b) => {
      if (op === 'voz') return hojaVoces(voz.libro)
      const nueva = Math.min(30, Math.max(15, prefs().letra + Number(b.dataset.d)))
      guardarPref('letra', nueva)
      document.documentElement.style.setProperty('--letra', `${nueva}px`)
      pintar()
    })
  }
  pintar()
}

function hojaCapitulos(libro, actual) {
  abrirHoja(`<h3>${esc(libro.titulo)}</h3>${libro.capitulos.map((c) => `
    <button class="opcion ${c.n === actual ? 'on' : ''}" data-h="${c.nn}" ${!c.texto && !c.audio ? 'disabled style="opacity:.4"' : ''}>
      <span>${c.n}. ${esc(c.titulo)}</span><span class="num" style="color:var(--muted);font-size:14px;flex:none;margin-left:10px">${c.audio ? duracionHumana(c.duracion) : 'texto'}</span></button>`).join('')}`,
  (nnSel) => ir(`#/leer/${encodeURIComponent(libro.slug)}/${nnSel}`))
}

// ── Ajustes y descargas ──────────────────────────────────────────────────
async function vistaAjustes(mio) {
  const [{ libros }, inv, est, persistido, sesion] = await Promise.all([
    api.libros(), inventario(), navigator.storage?.estimate?.().catch(() => null), navigator.storage?.persisted?.().catch(() => null), api.sesion().catch(() => null),
  ])
  if (!vigente(mio)) return null
  const filas = Object.entries(inv).map(([slug, d]) => {
    const l = libros.find((x) => x.slug === slug)
    return `<div class="fila"><div>${esc(l?.titulo || slug)}<small class="num">${d.capitulos} capítulos · ${megas(d.bytes)}</small></div>
      <button class="boton-icono" data-borrar="${esc(slug)}" aria-label="Borrar descarga">${icono.basura}</button></div>`
  }).join('')
  vista.innerHTML = `
    <div class="pagina ajustes">
      <div class="cabecera"><a class="boton-icono" href="#/" aria-label="Biblioteca">${icono.atras}</a><h1 class="titulo-grande" style="font-size:26px">Ajustes</h1><span style="width:40px"></span></div>
      <div class="seccion">Descargas en este teléfono</div>
      ${filas || '<div class="fila"><div style="color:var(--muted)">Nada descargado todavía</div></div>'}
      <div class="fila"><div>Espacio usado<small class="num">${est ? `${megas(est.usage || 0)} de ${megas(est.quota || 0)} disponibles` : 'No disponible'}</small></div></div>
      <div class="fila"><div>Almacenamiento protegido<small>${persistido ? 'Sí: el sistema no borrará tus descargas' : 'Se pide al descargar el primer libro'}</small></div></div>
      <div class="seccion">Acceso</div>
      ${sesion?.protegida
        ? '<div class="fila"><div>Con contraseña<small>Sesión abierta en este teléfono</small></div><button class="peligro" data-accion="salir">Salir</button></div>'
        : '<div class="fila"><div>Sin contraseña<small>Cualquiera en tu red local puede entrar. Pon AUDIOTECA_CONTRASENA en .env para pedirla.</small></div></div>'}
      <div class="seccion">Cómo instalarla</div>
      <p class="nota" style="font-style:normal">En Safari: botón Compartir → «Agregar a inicio». Se abre a pantalla completa y sigue sonando con la pantalla bloqueada.</p>
    </div>`
  vista.onclick = async (ev) => {
    const b = ev.target.closest('[data-borrar],[data-accion]')
    if (!b) return
    if (b.dataset.borrar) { await borrarLibro(b.dataset.borrar); avisar('Descarga borrada'); render() }
    if (b.dataset.accion === 'salir') { R.pausa(); await api.salir().catch(() => {}); vistaEntrada() }
  }
  return () => { vista.onclick = null }
}

// ── Mini reproductor ─────────────────────────────────────────────────────
function pintarMini() {
  const [seccion] = ruta()
  const { libro, cap } = R.estado
  // En la biblioteca, si «Continuar» ya muestra ese libro, el mini sobra (dirían lo mismo dos veces).
  const continuar = vista.querySelector('[data-continuar]')
  const duplicado = continuar && continuar.dataset.continuar === libro?.slug
  const visible = !!(libro && cap) && seccion !== 'leer' && !!vista.querySelector('.pagina') && !duplicado
  mini.hidden = !visible
  document.documentElement.style.setProperty('--mini-alto', visible ? '72px' : '0px')
  if (!visible) return
  mini.className = 'titanio'
  mini.innerHTML = `
    ${portadaHtml(libro)}
    <button class="q" data-accion="abrir"><b>${esc(cap.titulo)}</b><span>${esc(libro.titulo)} · ${velTexto(R.velocidad())}</span></button>
    <button class="boton-icono" data-accion="play" aria-label="${R.elemento.paused ? 'Reproducir' : 'Pausa'}">${R.elemento.paused ? icono.play : icono.pausa}</button>
    <button class="boton-icono salto" data-accion="adelante" aria-label="Adelante 30 segundos">${icono.mas30}<small>30</small></button>
    <i class="hilo"></i>`
  pintarHilo()
}
function pintarHilo() {
  const hilo = mini.querySelector('.hilo')
  if (!hilo || mini.hidden) return
  const t = R.tiempos()
  hilo.style.width = `${t.dur ? (t.t / t.dur) * 100 : 0}%`
}
mini.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-accion]')
  if (!b) return
  if (b.dataset.accion === 'play') R.alternar()
  if (b.dataset.accion === 'adelante') R.adelante()
  if (b.dataset.accion === 'abrir' && R.estado.libro) ir(`#/leer/${encodeURIComponent(R.estado.libro.slug)}/${R.estado.cap.nn}`)
})
R.on('estado', pintarMini)
R.on('capitulo', pintarMini)
R.on('velocidad', pintarMini)
R.on('tiempo', pintarHilo)

// ── Arranque ─────────────────────────────────────────────────────────────
render().then(() => {
  const ultimo = ultimoLibro()
  if (ultimo && !R.estado.libro && ruta()[0] !== 'leer') R.prepararUltimo(ultimo).then(pintarMini)
})
window.__audioteca = { R, ir } // para las pruebas e2e
