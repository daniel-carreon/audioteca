// Service worker de la Audioteca (alcance: la carpeta de la app).
//  · Shell: index.html sale de la caché al instante y se revalida detrás; todo lo que referencia va sellado
//    con el hash de su contenido (`?h=…`, lo pone el servidor), así que se sirve de la caché sin preguntar y
//    una versión nueva llega completa en la siguiente apertura. No hay lista de archivos que mantener a mano.
//  · Datos (API JSON): red primero con tope de espera; si no hay red, la última copia.
//  · Audio: si el capítulo está descargado se sirve desde Cache Storage CON Range (Safari exige 206 para
//    reproducir y adelantar). Si no, puede venir el arranque precargado (los primeros ~45 s del capítulo
//    siguiente, que el reproductor pide antes de que acabe el actual) y el resto de la red.
//  · Nunca borra `audioteca-libros-*` (tus descargas) al actualizarse.
//  · Un capítulo descargado se alinea palabra a palabra después (el trabajo de palabras va por detrás del narrador):
//    si con red llega su texto con "palabras" más completa y los MISMOS segmentos (mismo audio), se actualiza la copia
//    descargada, así sin red también se lee palabra a palabra.
const VERSION = 'v8-2026-11-10'
const SHELL = 'audioteca-shell-v2'
const DATOS = 'audioteca-datos-v1'
const LIBROS = 'audioteca-libros-v1'
const PRECARGA = 'audioteca-precarga-v1'
const ESPERA_RED_MS = 3500
const PRECARGAS_MAX = 4

const base = new URL('./', self.location).pathname // el prefijo si hay proxy, / en local
const INDEX = new URL('./', self.location).href

/** Baja index.html y todo lo sellado que referencia; borra lo sellado que ya nadie usa. */
async function instalarShell() {
  const cache = await caches.open(SHELL)
  const r = await fetch(INDEX, { cache: 'no-cache' })
  if (!r.ok) throw new Error(`index ${r.status}`)
  const html = await r.clone().text()
  const sellados = [...html.matchAll(/(?:href|src)="([^"]+\?h=[^"]+)"/g)].map((m) => new URL(m[1], INDEX).href)
  await Promise.all(sellados.map(async (u) => { if (!(await cache.match(u))) await cache.add(new Request(u, { cache: 'reload' })) }))
  await cache.put(INDEX, r)
  const vigentes = new Set(sellados)
  for (const k of await cache.keys()) if (k.url.includes('?h=') && !vigentes.has(k.url)) await cache.delete(k)
}

self.addEventListener('install', (ev) => {
  ev.waitUntil(instalarShell().then(() => self.skipWaiting()))
})

self.addEventListener('activate', (ev) => {
  ev.waitUntil((async () => {
    for (const n of await caches.keys()) if (n.startsWith('audioteca-shell-') && n !== SHELL) await caches.delete(n)
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (ev) => {
  const { request } = ev
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || !url.pathname.startsWith(base)) return
  const ruta = url.pathname.slice(base.length - 1)

  if (/^\/api\/libros\/[^/]+\/audio\/(?:[^/]+\/)?\d+\.mp3$/.test(ruta)) return ev.respondWith(audio(request))
  if (ruta.startsWith('/portada-generada/')) return ev.respondWith(caches.match(request, { cacheName: DATOS }).then((r) => r || fetch(request)))
  if (ruta.startsWith('/api/')) {
    if (ruta === '/api/login' || ruta === '/api/salir') return
    return ev.respondWith(datos(request, ev))
  }
  if (request.mode === 'navigate' || ruta === '/' || ruta === '/index.html') return ev.respondWith(pagina(request, ev))
  if (url.searchParams.has('h')) return ev.respondWith(sellado(request))
  return ev.respondWith(revalidando(request, ev))
})

/** index.html: de la caché al instante; detrás se revalida (y se baja lo sellado de la versión nueva). */
async function pagina(request, ev) {
  const cache = await caches.open(SHELL)
  const guardada = await cache.match(INDEX)
  if (guardada) { ev.waitUntil(instalarShell().catch(() => {})); return guardada }
  const r = await fetch(request)
  if (r.ok) ev.waitUntil(instalarShell().catch(() => {}))
  return r
}

/** URL sellada: su contenido no cambia nunca. */
async function sellado(request) {
  const cache = await caches.open(SHELL)
  const guardada = await cache.match(request)
  if (guardada) return guardada
  const r = await fetch(request)
  if (r.ok && r.type === 'basic') cache.put(request, r.clone())
  return r
}

/** sw.js, manifest, íconos sin sello: la copia al instante y se actualiza detrás. */
async function revalidando(request, ev) {
  const cache = await caches.open(SHELL)
  const guardada = await cache.match(request, { ignoreSearch: true })
  const red = fetch(request).then((r) => {
    if (r.ok && r.type === 'basic') cache.put(request, r.clone())
    return r
  })
  if (guardada) { ev.waitUntil(red.catch(() => {})); return guardada }
  return red
}

async function datos(request, ev) {
  const cache = await caches.open(DATOS)
  const desdeCache = async () => (await cache.match(request)) || (await caches.match(request, { cacheName: LIBROS }))
  try {
    const r = await Promise.race([
      fetch(request),
      new Promise((_, mal) => setTimeout(() => mal(new Error('lenta')), ESPERA_RED_MS)),
    ])
    if (r.ok) {
      ev.waitUntil(cache.put(request, r.clone()))
      if (/\/api\/libros\/[^/]+\/capitulos\/\d+$/.test(new URL(request.url).pathname)) ev.waitUntil(mejorarDescarga(request, r.clone()).catch(() => {}))
    }
    return r
  } catch (e) {
    const guardada = await desdeCache()
    if (guardada) return guardada
    // La red lenta no es red caída: si no hay copia, se espera a la red de verdad.
    if (e.message === 'lenta') return fetch(request)
    return new Response(JSON.stringify({ error: 'Sin conexión' }), { status: 503, headers: { 'content-type': 'application/json' } })
  }
}

/** Si este capítulo está descargado y la red trae más palabras alineadas para el mismo audio, reemplaza la copia. */
async function mejorarDescarga(request, r) {
  const libros = await caches.open(LIBROS)
  const vieja = await libros.match(request)
  if (!vieja) return
  const [antes, ahora] = await Promise.all([vieja.json(), r.clone().json()])
  const n = (d) => (Array.isArray(d?.palabras) ? d.palabras.length : 0)
  if (n(ahora) <= n(antes)) return
  if (JSON.stringify(antes.segmentos || []) !== JSON.stringify(ahora.segmentos || [])) return // otro audio: no se toca
  await libros.put(request, r)
}

async function audio(request) {
  const cache = await caches.open(LIBROS)
  const guardada = (await cache.match(request.url)) || (!navigator.onLine && (await cache.match(request.url, { ignoreSearch: true })))
  if (guardada) return conRango(request, await guardada.blob())
  const pre = await (await caches.open(PRECARGA)).match(request.url)
  if (pre) {
    const total = Number(pre.headers.get('x-total'))
    const m = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get('range') || '')
    const blob = await pre.blob()
    // Solo si el rango pedido empieza dentro de lo precargado; el resto lo pide el reproductor a la red.
    if (m && total && Number(m[1]) < blob.size) return conRango(request, blob, total)
  }
  return fetch(request)
}

/** Respuesta 206 desde un blob. Con `total` mayor que el blob, el blob es el arranque del archivo. */
function conRango(request, blob, total = blob.size) {
  const cabeceras = { 'content-type': 'audio/mpeg', 'accept-ranges': 'bytes' }
  const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '')
  if (!m) return new Response(blob, { status: 200, headers: { ...cabeceras, 'content-length': String(total) } })
  let inicio = m[1] === '' ? null : Number(m[1])
  let fin = m[2] === '' ? null : Number(m[2])
  if (inicio === null) { inicio = Math.max(0, total - (fin || 0)); fin = total - 1 }
  if (fin === null || fin >= total) fin = total - 1
  if (inicio > fin || inicio >= total) return new Response(null, { status: 416, headers: { ...cabeceras, 'content-range': `bytes */${total}` } })
  fin = Math.min(fin, blob.size - 1)
  return new Response(blob.slice(inicio, fin + 1), {
    status: 206,
    headers: { ...cabeceras, 'content-range': `bytes ${inicio}-${fin}/${total}`, 'content-length': String(fin - inicio + 1) },
  })
}

// El reproductor avisa qué capítulo viene: se baja su arranque para que el cambio suene sin esperar a la red.
self.addEventListener('message', (ev) => {
  const d = ev.data || {}
  if (d.tipo === 'precargar' && typeof d.url === 'string' && new URL(d.url).origin === self.location.origin) {
    ev.waitUntil(precargar(d.url, Number(d.bytes) || 512 * 1024).catch(() => {}))
  }
})

async function precargar(url, bytes) {
  if (await caches.match(url, { cacheName: LIBROS })) return
  const cache = await caches.open(PRECARGA)
  if (await cache.match(url)) return
  const r = await fetch(url, { headers: { range: `bytes=0-${bytes - 1}` }, credentials: 'same-origin' })
  const total = Number((/\/(\d+)$/.exec(r.headers.get('content-range') || '') || [])[1])
  if (r.status !== 206 || !total) return
  const blob = await r.blob()
  await cache.put(url, new Response(blob, { headers: { 'content-type': 'audio/mpeg', 'x-total': String(total) } }))
  const llaves = await cache.keys()
  for (const k of llaves.slice(0, Math.max(0, llaves.length - PRECARGAS_MAX))) await cache.delete(k)
}
