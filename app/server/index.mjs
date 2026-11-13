// Servidor de la Audioteca. Node puro, sin dependencias: sirve la PWA y una API mínima de solo lectura
// sobre la carpeta de libros (AUDIOTECA_LIBROS), con contraseña opcional. Por defecto escucha en toda la red
// local (0.0.0.0) para que el iPhone entre por http://<ip-de-tu-mac>:3410/; con AUDIOTECA_TLS_CERT y
// AUDIOTECA_TLS_KEY sirve HTTPS (necesario para las descargas offline fuera de localhost). Ver README.
import { createServer } from 'node:http'
import { createServer as createServerTls } from 'node:https'
import { networkInterfaces } from 'node:os'
import { createReadStream, readFileSync, statSync, writeFileSync, renameSync, mkdirSync, realpathSync } from 'node:fs'
import { join, dirname, extname, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { listarLibros, leerLibro, leerCapitulo, rutaAudio, archivoPortada, SLUG, NN, VOZ } from './libros.mjs'
import { crearVoces } from './voces.mjs'
import { crearEstaticos, comprimir, TIPOS } from './estaticos.mjs'
import { COOKIE, cargarSecreto, emitir, verificar, leerCookies, cookieSesion, limitador, huella, contraseñaCorrecta } from './sesion.mjs'
import { entorno, ruta as rutaDe } from './config.mjs'

const RAIZ_APP = join(dirname(fileURLToPath(import.meta.url)), '..')
const PUBLICO = join(RAIZ_APP, 'public')

export function configDesdeEntorno(env = entorno()) {
  const trabajo = rutaDe(env.AUDIOTECA_TRABAJO, '.trabajo')
  return {
    puerto: Number(env.AUDIOTECA_PUERTO || 3410),
    host: env.AUDIOTECA_HOST || '0.0.0.0',
    libros: rutaDe(env.AUDIOTECA_LIBROS, 'biblioteca'),
    narrador: join(trabajo, 'narrador'),
    voces: rutaDe(env.AUDIOTECA_VOCES, 'voces'),
    datos: rutaDe(env.AUDIOTECA_DATOS, '.data'),
    prefijo: (env.AUDIOTECA_PREFIJO || '').replace(/\/$/, ''),
    tls: env.AUDIOTECA_TLS_CERT && env.AUDIOTECA_TLS_KEY ? { cert: rutaDe(env.AUDIOTECA_TLS_CERT), key: rutaDe(env.AUDIOTECA_TLS_KEY) } : null,
    // La cookie «Secure» solo viaja por HTTPS: en la red local (http) tiene que ir sin esa marca.
    cookieSegura: env.AUDIOTECA_COOKIE_SEGURA ? env.AUDIOTECA_COOKIE_SEGURA === '1' : !!(env.AUDIOTECA_TLS_CERT && env.AUDIOTECA_TLS_KEY),
    contraseña: env.AUDIOTECA_CONTRASENA || '',
  }
}

const CABECERAS_BASE = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
}

function responder(res, estado, cuerpo, cabeceras = {}) {
  const esJson = typeof cuerpo !== 'string' && !Buffer.isBuffer(cuerpo)
  const datos = esJson ? JSON.stringify(cuerpo) : cuerpo
  res.writeHead(estado, {
    ...CABECERAS_BASE,
    'content-type': esJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    ...tiempo(res),
    ...cabeceras,
  })
  res.end(res.req.method === 'HEAD' ? undefined : datos)
}

const tiempo = (res) => (res.inicio ? { 'server-timing': `app;dur=${(Number(process.hrtime.bigint() - res.inicio) / 1e6).toFixed(1)}` } : {})

/** Datos de la API: comprimidos y con ETag, así revalidar una ficha que no cambió cuesta un 304 vacío. */
function responderDatos(req, res, cuerpo) {
  const buf = Buffer.from(JSON.stringify(cuerpo))
  const etag = `W/"${createHash('sha1').update(buf).digest('base64url').slice(0, 16)}"`
  const base = { ...CABECERAS_BASE, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-cache', etag, vary: 'accept-encoding', ...tiempo(res) }
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, base); return res.end() }
  const { cuerpo: salida, codificacion } = buf.length > 1024 ? comprimir(buf, req.headers['accept-encoding']) : { cuerpo: buf }
  res.writeHead(200, { ...base, ...(codificacion ? { 'content-encoding': codificacion } : {}), 'content-length': salida.length })
  res.end(req.method === 'HEAD' ? undefined : salida)
}

/** Archivo con soporte de Range (Safari pide bytes=0-1 antes de reproducir) y ETag. */
function servirArchivo(req, res, ruta, { cache = 'no-cache', tipo } = {}) {
  let st
  try { st = statSync(ruta) } catch { return responder(res, 404, { error: 'no existe' }) }
  if (!st.isFile()) return responder(res, 404, { error: 'no existe' })
  const etag = `"${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}"`
  const base = {
    ...CABECERAS_BASE,
    'content-type': tipo || TIPOS[extname(ruta).toLowerCase()] || 'application/octet-stream',
    'cache-control': cache,
    'accept-ranges': 'bytes',
    etag,
    'last-modified': st.mtime.toUTCString(),
  }
  if (req.headers['if-none-match'] === etag && !req.headers.range) {
    res.writeHead(304, base)
    return res.end()
  }
  const rango = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
  if (rango && (!req.headers['if-range'] || req.headers['if-range'] === etag)) {
    let inicio = rango[1] === '' ? null : Number(rango[1])
    let fin = rango[2] === '' ? null : Number(rango[2])
    if (inicio === null) { inicio = Math.max(0, st.size - (fin ?? 0)); fin = st.size - 1 }
    if (fin === null || fin >= st.size) fin = st.size - 1
    if (inicio > fin || inicio >= st.size) {
      res.writeHead(416, { ...base, 'content-range': `bytes */${st.size}` })
      return res.end()
    }
    res.writeHead(206, { ...base, 'content-range': `bytes ${inicio}-${fin}/${st.size}`, 'content-length': fin - inicio + 1 })
    if (req.method === 'HEAD') return res.end()
    return createReadStream(ruta, { start: inicio, end: fin }).pipe(res)
  }
  res.writeHead(200, { ...base, 'content-length': st.size })
  if (req.method === 'HEAD') return res.end()
  createReadStream(ruta).pipe(res)
}

function leerCuerpo(req, max = 16 * 1024) {
  return new Promise((ok, mal) => {
    let datos = ''
    req.setEncoding('utf8')
    req.on('data', (c) => {
      datos += c
      if (datos.length > max) { mal(new Error('cuerpo demasiado grande')); req.destroy() }
    })
    req.on('end', () => {
      try { ok(datos ? JSON.parse(datos) : {}) } catch { mal(new Error('json inválido')) }
    })
    req.on('error', mal)
  })
}

function ipDe(req) {
  // X-Forwarded-For solo se cree si la petición llega de un proxy en este mismo Mac (Tailscale Serve, Caddy);
  // desde la red local cualquiera podría inventarlo para saltarse el límite de intentos.
  const directa = req.socket.remoteAddress || ''
  const local = /^(127\.|::1$|::ffff:127\.)/.test(directa)
  return String((local && req.headers['x-forwarded-for']) || directa).split(',')[0].trim()
}

/** Progreso por libro en el servidor: el teléfono es la fuente, esto es respaldo y sincronía entre dispositivos. */
function almacenProgreso(ruta) {
  let estado = {}
  try { estado = JSON.parse(readFileSync(ruta, 'utf8')) } catch { estado = {} }
  return {
    todo: () => estado,
    guardar(slug, p) {
      const previo = estado[slug]
      if (previo && previo.ts > p.ts) return previo // gana el más reciente
      estado[slug] = p
      mkdirSync(dirname(ruta), { recursive: true })
      const tmp = `${ruta}.tmp`
      writeFileSync(tmp, JSON.stringify(estado))
      renameSync(tmp, ruta)
      return p
    },
  }
}

function validarProgreso(b) {
  const cap = Number(b?.cap)
  const t = Number(b?.t)
  const vel = Number(b?.vel)
  const ts = Number(b?.ts)
  if (!Number.isInteger(cap) || cap < 1 || cap > 999) return null
  if (!Number.isFinite(t) || t < 0 || t > 86400) return null
  if (!Number.isFinite(ts) || ts <= 0) return null
  const p = { cap, t: Math.round(t * 10) / 10, ts }
  if (Number.isFinite(vel) && vel >= 0.5 && vel <= 3.5) p.vel = vel
  if (b.fin === true) p.fin = true
  if (typeof b.voz === 'string' && VOZ.test(b.voz)) p.voz = b.voz
  return p
}

export function crearServidor(cfg = configDesdeEntorno()) {
  const secreto = cargarSecreto(join(cfg.datos, 'secreto'))
  const progreso = almacenProgreso(join(cfg.datos, 'progreso.json'))
  const intentos = limitador()
  const voces = crearVoces({ voces: cfg.voces || join(cfg.datos, 'sin-voces'), narrador: cfg.narrador || join(cfg.datos, 'sin-narrador') })
  const h = huella(secreto, cfg.contraseña)
  const estaticos = crearEstaticos(PUBLICO)
  const fichaCompleta = (slug) => {
    const libro = leerLibro(cfg.libros, slug)
    return libro && { ...libro, ...voces.deLibro(libro) }
  }

  // Sin contraseña configurada la app está abierta (red local de confianza).
  const sesionDe = (req) => (cfg.contraseña ? verificar(secreto, leerCookies(req)[COOKIE], h) : { abierta: true })
  const cookie = (valor, borrar) => {
    const c = cookieSesion(valor, cfg.prefijo || '/', borrar)
    return cfg.cookieSegura ? c : c.replace('; Secure', '')
  }

  async function api(req, res, ruta, url) {
    if (ruta === '/api/login' && req.method === 'POST') {
      const ip = ipDe(req)
      if (!intentos.permitido(ip)) return responder(res, 429, { error: 'Demasiados intentos. Espera unos minutos.' })
      let cuerpo
      try { cuerpo = await leerCuerpo(req) } catch { return responder(res, 400, { error: 'Petición inválida' }) }
      if (!cfg.contraseña) return responder(res, 200, { protegida: false })
      if (!contraseñaCorrecta(cfg.contraseña, cuerpo.contraseña)) {
        intentos.fallo(ip)
        return responder(res, 401, { error: 'Contraseña incorrecta' })
      }
      intentos.limpiar(ip)
      return responder(res, 200, { protegida: true }, { 'set-cookie': cookie(emitir(secreto, h)) })
    }
    if (ruta === '/api/salir' && req.method === 'POST') {
      return responder(res, 200, { ok: true }, { 'set-cookie': cookie('', true) })
    }

    const sesion = sesionDe(req)
    if (!sesion) return responder(res, 401, { error: 'Sin sesión' })

    if (ruta === '/api/sesion') return responder(res, 200, { protegida: !!cfg.contraseña })

    if (ruta === '/api/progreso' && req.method === 'GET') return responderDatos(req, res, progreso.todo())
    let m = /^\/api\/progreso\/([^/]+)$/.exec(ruta)
    if (m && req.method === 'PUT') {
      if (!SLUG.test(m[1])) return responder(res, 400, { error: 'slug inválido' })
      let cuerpo
      try { cuerpo = await leerCuerpo(req) } catch { return responder(res, 400, { error: 'Petición inválida' }) }
      const p = validarProgreso(cuerpo)
      if (!p) return responder(res, 400, { error: 'progreso inválido' })
      return responder(res, 200, progreso.guardar(m[1], p))
    }

    // Pedir (o cancelar) que el narrador haga el libro en otra voz: escribe narrador/pedidos.json.
    m = /^\/api\/libros\/([^/]+)\/voces\/([^/]+)$/.exec(ruta)
    if (m && (req.method === 'POST' || req.method === 'DELETE')) {
      if (!SLUG.test(m[1]) || !VOZ.test(m[2])) return responder(res, 400, { error: 'petición inválida' })
      if (!/^application\/json/.test(req.headers['content-type'] || '')) return responder(res, 415, { error: 'se espera JSON' })
      const libro = leerLibro(cfg.libros, m[1])
      if (!libro) return responder(res, 404, { error: 'libro no encontrado' })
      if (req.method === 'DELETE') voces.cancelar(m[1], m[2])
      else {
        const motivo = voces.pedir(libro, m[2])
        if (motivo) return responder(res, 409, { error: motivo })
      }
      return responderDatos(req, res, fichaCompleta(m[1]))
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return responder(res, 405, { error: 'método no permitido' })

    if (ruta === '/api/libros') {
      const libros = listarLibros(cfg.libros).map(({ capitulos, ...resto }) => ({
        ...resto,
        capitulos: capitulos.length,
        // Solo lo que la biblioteca necesita para pintar estado sin bajar cada ficha: [n, v, voz] de cada narración.
        versiones: capitulos.flatMap((c) => Object.entries(c.narraciones).map(([voz, x]) => [c.n, x.v, voz])),
      }))
      return responderDatos(req, res, { libros })
    }
    m = /^\/api\/libros\/([^/]+)$/.exec(ruta)
    if (m) {
      const libro = fichaCompleta(m[1])
      return libro ? responderDatos(req, res, libro) : responder(res, 404, { error: 'libro no encontrado' })
    }
    m = /^\/api\/libros\/([^/]+)\/capitulos\/([^/]+)$/.exec(ruta)
    if (m) {
      const voz = url.searchParams.get('voz')
      const cap = leerCapitulo(cfg.libros, m[1], m[2], voz || null)
      return cap ? responderDatos(req, res, cap) : responder(res, 404, { error: 'capítulo no encontrado' })
    }
    // audio/<voz>/NN.mp3 (v2) y audio/NN.mp3 (la narración por omisión de ese capítulo, como en v1).
    m = /^\/api\/libros\/([^/]+)\/audio\/(?:([^/]+)\/)?(\d{2,3})\.mp3$/.exec(ruta)
    if (m && SLUG.test(m[1]) && NN.test(m[3]) && (!m[2] || VOZ.test(m[2]))) {
      const mp3 = rutaAudio(cfg.libros, m[1], m[3], m[2] || null)
      if (!mp3) return responder(res, 404, { error: 'no existe' })
      return servirArchivo(req, res, mp3, { cache: 'private, max-age=31536000, immutable' })
    }
    m = /^\/api\/libros\/([^/]+)\/portada$/.exec(ruta)
    if (m) {
      const libro = leerLibro(cfg.libros, m[1])
      const dir = join(cfg.libros, m[1])
      const archivo = libro?.portada && archivoPortada(dir, JSON.parse(readFileSync(join(dir, 'libro.json'), 'utf8')))
      if (!archivo) return responder(res, 404, { error: 'sin portada' })
      return servirArchivo(req, res, join(dir, archivo), { cache: 'private, max-age=86400' })
    }
    m = /^\/api\/libros\/([^/]+)\/glosario$/.exec(ruta)
    if (m) {
      const libro = leerLibro(cfg.libros, m[1])
      if (!libro?.glosario) return responder(res, 404, { error: 'sin glosario' })
      return servirArchivo(req, res, join(cfg.libros, m[1], 'glosario.md'))
    }
    return responder(res, 404, { error: 'ruta desconocida' })
  }

  /** Shell de la PWA desde memoria: sellado con hash (immutable), comprimido y con ETag. */
  function estatico(req, res, ruta, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return responder(res, 405, { error: 'método no permitido' })
    let relativa
    try { relativa = posix.normalize(decodeURIComponent(ruta === '/' ? '/index.html' : ruta)) } catch { return responder(res, 400, { error: 'ruta inválida' }) }
    // Rutas del cliente (#/...) viven en el hash; cualquier otra cosa sin archivo es 404.
    const a = !relativa.includes('..') && estaticos.obtener(relativa)
    if (!a) return responder(res, 404, { error: 'no existe' })
    const sellada = url.searchParams.get('h') === a.hash
    const etag = `"${a.hash}"`
    const cab = {
      ...CABECERAS_BASE,
      'content-type': a.tipo,
      // Con el hash correcto en la URL el contenido no cambia nunca; sin él (index.html, sw.js, manifest) se revalida.
      'cache-control': sellada ? 'public, max-age=31536000, immutable' : 'no-cache',
      etag,
      vary: 'accept-encoding',
      ...(relativa === '/sw.js' ? { 'service-worker-allowed': './' } : {}),
    }
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, cab); return res.end() }
    const acepta = req.headers['accept-encoding'] || ''
    const [cuerpo, codificacion] = a.br && /\bbr\b/.test(acepta) ? [a.br, 'br'] : a.gzip && /\bgzip\b/.test(acepta) ? [a.gzip, 'gzip'] : [a.cuerpo, null]
    res.writeHead(200, { ...cab, ...(codificacion ? { 'content-encoding': codificacion } : {}), 'content-length': cuerpo.length })
    res.end(req.method === 'HEAD' ? undefined : cuerpo)
  }

  const manejar = async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local')
      let ruta = url.pathname
      if (cfg.prefijo && ruta === cfg.prefijo) {
        res.writeHead(301, { location: `${cfg.prefijo}/${url.search}` })
        return res.end()
      }
      // Un proxy inverso puede entregar la ruta con o sin el prefijo; se acepta de las dos formas.
      if (cfg.prefijo && (ruta === cfg.prefijo || ruta.startsWith(cfg.prefijo + '/'))) ruta = ruta.slice(cfg.prefijo.length) || '/'
      if (ruta.startsWith('/api/')) {
        res.inicio = process.hrtime.bigint()
        return await api(req, res, ruta, url)
      }
      return estatico(req, res, ruta, url)
    } catch (e) {
      console.error(new Date().toISOString(), req.method, req.url, e)
      if (!res.headersSent) responder(res, 500, { error: 'error interno' })
      else res.destroy()
    }
  }
  const servidor = cfg.tls
    ? createServerTls({ cert: readFileSync(cfg.tls.cert), key: readFileSync(cfg.tls.key) }, manejar)
    : createServer(manejar)
  // Conexiones vivas más tiempo que el default (5 s): un proxy (Tailscale, Caddy) las reutiliza entre toques.
  servidor.keepAliveTimeout = 65_000
  servidor.headersTimeout = 66_000
  return servidor
}

/** Direcciones IPv4 de la red local, para decir a qué URL entrar desde el teléfono. */
function ipsLocales() {
  return Object.values(networkInterfaces()).flat().filter((x) => x && x.family === 'IPv4' && !x.internal).map((x) => x.address)
}

/** ¿Se corre este archivo directamente? (con realpath: /tmp en macOS es un symlink a /private/tmp) */
function esPrincipal() {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}

if (esPrincipal()) {
  const cfg = configDesdeEntorno()
  crearServidor(cfg).listen(cfg.puerto, cfg.host, () => {
    const esquema = cfg.tls ? 'https' : 'http'
    const hosts = cfg.host === '0.0.0.0' ? ['localhost', ...ipsLocales()] : [cfg.host]
    console.log(`${new Date().toISOString()} Audioteca lista · libros: ${cfg.libros} · contraseña: ${cfg.contraseña ? 'sí' : 'no (abierta en tu red local)'}`)
    for (const x of hosts) console.log(`  ${esquema}://${x}:${cfg.puerto}${cfg.prefijo}/`)
  })
}
