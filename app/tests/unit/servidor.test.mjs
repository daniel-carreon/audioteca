import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, cpSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { crearServidor } from '../../server/index.mjs'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '../..')
let servidor, abierto, base, cookie
const libros = mkdtempSync(join(tmpdir(), 'audioteca-libros-'))
const narrador = mkdtempSync(join(tmpdir(), 'audioteca-narrador-'))
const voces = mkdtempSync(join(tmpdir(), 'audioteca-voces-'))
const datos = mkdtempSync(join(tmpdir(), 'audioteca-datos-'))

function copiarFixture() {
  const origen = join(raiz, 'fixtures/libros/prueba-audioteca')
  cpSync(origen, join(libros, 'prueba-audioteca'), { recursive: true })
  // El mismo libro en la forma v1 (audio/NN.* sin carpeta de voz, json sin «voz»): cuenta como la voz del libro.
  const viejo = join(libros, 'libro-v1')
  cpSync(join(origen, 'texto'), join(viejo, 'texto'), { recursive: true })
  mkdirSync(join(viejo, 'audio'))
  for (const n of ['01', '02']) {
    copyFileSync(join(origen, `audio/lectora/${n}.mp3`), join(viejo, `audio/${n}.mp3`))
    const { segmentos } = JSON.parse(readFileSync(join(origen, `audio/lectora/${n}.json`), 'utf8'))
    writeFileSync(join(viejo, `audio/${n}.json`), JSON.stringify({ segmentos }))
  }
  writeFileSync(join(viejo, 'libro.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(origen, 'libro.json'), 'utf8')), slug: 'libro-v1', voz: 'antigua' }))
  // Voces del Mac: trinity completa (wav + txt); «incompleta» no tiene txt y no cuenta.
  writeFileSync(join(voces, 'trinity.wav'), 'RIFF')
  writeFileSync(join(voces, 'trinity.txt'), 'Hola.')
  writeFileSync(join(voces, 'incompleta.wav'), 'RIFF')
  writeFileSync(join(narrador, 'cola.json'), JSON.stringify({ orden: ['prueba-audioteca'], excluidos: ['libro-v1'] }))
  // Ruido que la app debe tolerar: carpeta sin libro.json, json roto y un secreto fuera de `libros`.
  mkdirSync(join(libros, 'sin-ficha'))
  mkdirSync(join(libros, 'roto'))
  writeFileSync(join(libros, 'roto', 'libro.json'), '{"slug": "roto", "capitu')
  writeFileSync(join(libros, '..', 'secreto-fuera.txt'), 'no debe salir')
  // Palabras por palabra del libro de prueba (las escribe crear-fixture.mjs) solo para lectora: lector queda sin ellas.
  cpSync(join(raiz, 'fixtures/palabras/prueba-audioteca/lectora'), join(datos, 'palabras/prueba-audioteca/lectora'), { recursive: true })
}

before(async () => {
  copiarFixture()
  servidor = crearServidor({
    puerto: 0, host: '127.0.0.1', libros, narrador, voces, datos, prefijo: '/audioteca',
    cookieSegura: true, contraseña: 'correcta',
  }).listen(0)
  await new Promise((r) => servidor.once('listening', r))
  base = `http://127.0.0.1:${servidor.address().port}/audioteca`
  // La misma biblioteca sin contraseña (red local de confianza) y sin prefijo.
  abierto = crearServidor({ puerto: 0, host: '127.0.0.1', libros, narrador, voces, datos: mkdtempSync(join(tmpdir(), 'audioteca-datos-')), prefijo: '', cookieSegura: false, contraseña: '' }).listen(0)
  await new Promise((r) => abierto.once('listening', r))
})

after(() => { servidor.close(); abierto.close() })

const pedir = (ruta, opts = {}) => fetch(base + ruta, { redirect: 'manual', ...opts, headers: { ...(cookie ? { cookie } : {}), ...(opts.headers || {}) } })

test('sin sesión: el shell carga pero ningún dato sale', async () => {
  assert.equal((await pedir('/')).status, 200)
  for (const r of ['/api/libros', '/api/libros/prueba-audioteca', '/api/libros/prueba-audioteca/audio/01.mp3', '/api/libros/prueba-audioteca/capitulos/01', '/api/progreso']) {
    assert.equal((await pedir(r)).status, 401, r)
  }
})

test('/audioteca sin barra redirige a /audioteca/', async () => {
  const r = await fetch(base, { redirect: 'manual' })
  assert.equal(r.status, 301)
  assert.equal(r.headers.get('location'), '/audioteca/')
})

test('login: rechaza la contraseña mala y acepta la de .env con cookie segura', async () => {
  const login = (contraseña) => pedir('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contraseña }) })
  assert.equal((await login('mala')).status, 401)
  assert.equal((await login('')).status, 401)
  const r = await login('correcta')
  assert.equal(r.status, 200)
  const sc = r.headers.get('set-cookie')
  assert.match(sc, /HttpOnly/)
  assert.match(sc, /Secure/)
  assert.match(sc, /Path=\/audioteca/)
  cookie = sc.split(';')[0]
  const s = await pedir('/api/sesion')
  assert.equal(s.status, 200)
  assert.deepEqual(await s.json(), { protegida: true })
})

test('sin contraseña en .env la app queda abierta (y lo dice)', async () => {
  const b = `http://127.0.0.1:${abierto.address().port}`
  assert.equal((await fetch(b + '/api/libros')).status, 200)
  assert.deepEqual(await (await fetch(b + '/api/sesion')).json(), { protegida: false })
  assert.equal((await fetch(b + '/')).status, 200)
})

test('cambiar la contraseña invalida las sesiones anteriores', async () => {
  const datos = mkdtempSync(join(tmpdir(), 'audioteca-datos-'))
  const levantar = (contraseña) => new Promise((ok) => { const s = crearServidor({ puerto: 0, host: '127.0.0.1', libros, narrador, voces, datos, prefijo: '', cookieSegura: false, contraseña }).listen(0, () => ok(s)) })
  const a = await levantar('vieja')
  const r = await fetch(`http://127.0.0.1:${a.address().port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contraseña: 'vieja' }) })
  const c = r.headers.get('set-cookie').split(';')[0]
  assert.equal((await fetch(`http://127.0.0.1:${a.address().port}/api/libros`, { headers: { cookie: c } })).status, 200)
  a.close()
  const b = await levantar('nueva')
  assert.equal((await fetch(`http://127.0.0.1:${b.address().port}/api/libros`, { headers: { cookie: c } })).status, 401)
  b.close()
})

test('cookie manipulada no entra', async () => {
  const [n, v] = cookie.split('=')
  const r = await fetch(base + '/api/libros', { headers: { cookie: `${n}=${v.slice(0, -2)}xx` } })
  assert.equal(r.status, 401)
})

test('biblioteca tolera ruido y reporta capítulos narrados', async () => {
  const { libros: lista } = await (await pedir('/api/libros')).json()
  assert.deepEqual(lista.map((l) => l.slug).sort(), ['libro-v1', 'prueba-audioteca'])
  const l = lista.find((x) => x.slug === 'prueba-audioteca')
  assert.equal(l.narrados, 2)
  assert.equal(l.capitulos, 3)
  assert.deepEqual(l.versiones.map(([n, , voz]) => `${n}:${voz}`).sort(), ['1:lector', '1:lectora', '2:lectora'])
  const ficha = await (await pedir('/api/libros/prueba-audioteca')).json()
  assert.deepEqual(ficha.capitulos.map((c) => [c.n, c.audio, c.texto]), [[1, true, true], [2, true, true], [3, false, true]])
  assert.ok(!JSON.stringify(ficha).includes(libros), 'no filtra rutas del disco')
})

test('portada: la que nombra libro.json o, si no nombra ninguna, portada.jpg de la carpeta', async () => {
  const sin = (await (await pedir('/api/libros')).json()).libros.find((x) => x.slug === 'libro-v1')
  assert.equal(sin.portada, null)
  assert.equal((await pedir('/api/libros/libro-v1/portada')).status, 404)
  writeFileSync(join(libros, 'libro-v1', 'portada.jpg'), 'JPEG')
  const con = (await (await pedir('/api/libros')).json()).libros.find((x) => x.slug === 'libro-v1')
  assert.match(con.portada, /^portada\?v=/)
  const r = await pedir('/api/libros/libro-v1/portada')
  assert.equal(r.status, 200)
  assert.equal(await r.text(), 'JPEG')
  const ruta = join(libros, 'libro-v1', 'libro.json')
  const meta = JSON.parse(readFileSync(ruta, 'utf8'))
  writeFileSync(ruta, JSON.stringify({ ...meta, portada: 'otra.png' }))   // nombra una que no existe: no cae a portada.jpg
  assert.equal((await pedir('/api/libros/libro-v1/portada')).status, 404)
  writeFileSync(ruta, JSON.stringify(meta))
})

test('varias voces: cada capítulo trae sus narraciones y la ficha la sección «Voces»', async () => {
  const ficha = await (await pedir('/api/libros/prueba-audioteca')).json()
  assert.equal(ficha.voz, 'lectora')
  assert.deepEqual(Object.keys(ficha.capitulos[0].narraciones).sort(), ['lector', 'lectora'])
  assert.deepEqual(Object.keys(ficha.capitulos[1].narraciones), ['lectora'])
  assert.equal(ficha.capitulos[0].voz, 'lectora', 'por omisión suena la voz del libro')
  const v = Object.fromEntries(ficha.voces.map((x) => [x.id, x]))
  assert.deepEqual(ficha.voces.map((x) => x.id), ['lectora', 'lector', 'trinity-clon', 'macos'], 'la del libro primero; «incompleta» (sin txt) no cuenta; macos siempre')
  assert.deepEqual([v.macos.nombre, v.macos.disponible, v.macos.pedible], ['Voz de macOS', true, true])
  assert.deepEqual([v['lectora'].narrados, v['lectora'].total, v['lectora'].principal, v['lectora'].enCola], [2, 3, true, true])
  assert.deepEqual([v['lector'].narrados, v['lector'].disponible, v['lector'].pedible], [1, false, false])
  assert.deepEqual([v['trinity-clon'].nombre, v['trinity-clon'].narrados, v['trinity-clon'].pedible], ['Trinity', 0, true])
  // Capítulo y audio en otra voz: mismos textos, otros tiempos.
  const p = await (await pedir('/api/libros/prueba-audioteca/capitulos/01?voz=lectora')).json()
  const j = await (await pedir('/api/libros/prueba-audioteca/capitulos/01?voz=lector')).json()
  assert.equal(j.voz, 'lector')
  assert.equal(j.segmentos.length, p.segmentos.length)
  assert.notDeepEqual(j.segmentos, p.segmentos)
  assert.equal((await pedir('/api/libros/prueba-audioteca/audio/lector/01.mp3', { headers: { range: 'bytes=0-1' } })).status, 206)
  assert.equal((await pedir('/api/libros/prueba-audioteca/audio/lector/02.mp3')).status, 404)
  assert.equal((await pedir('/api/libros/prueba-audioteca/audio/..%2Flector/01.mp3')).status, 404)
})

test('formato v1 (audio/NN.* sin carpeta de voz) sigue sonando como la voz del libro', async () => {
  const ficha = await (await pedir('/api/libros/libro-v1')).json()
  assert.deepEqual(ficha.capitulos.map((c) => c.voz), ['antigua', 'antigua', null])
  assert.equal(ficha.narrados, 2)
  for (const r of ['/api/libros/libro-v1/audio/01.mp3', '/api/libros/libro-v1/audio/antigua/01.mp3']) {
    assert.equal((await pedir(r, { headers: { range: 'bytes=0-1' } })).status, 206, r)
  }
  const cap = await (await pedir('/api/libros/libro-v1/capitulos/01')).json()
  assert.ok(cap.audio && cap.segmentos.length > 5)
})

test('pedir otra voz escribe pedidos.json; respeta excluidos y voces que no existen', async () => {
  const post = (ruta, metodo = 'POST', tipo = 'application/json') => pedir(ruta, { method: metodo, headers: { 'content-type': tipo }, body: '{}' })
  assert.equal((await post('/api/libros/prueba-audioteca/voces/trinity-clon', 'POST', 'text/plain')).status, 415)
  assert.equal((await post('/api/libros/prueba-audioteca/voces/nadie-clon')).status, 409)
  assert.equal((await post('/api/libros/libro-v1/voces/trinity-clon')).status, 409, 'libro fuera de la cola')
  let r = await post('/api/libros/prueba-audioteca/voces/trinity-clon')
  assert.equal(r.status, 200)
  let v = (await r.json()).voces.find((x) => x.id === 'trinity-clon')
  assert.deepEqual([v.enCola, v.pedida, v.pedible], [true, true, false])
  await post('/api/libros/prueba-audioteca/voces/trinity-clon')
  const { pedidos } = JSON.parse(readFileSync(join(narrador, 'pedidos.json'), 'utf8'))
  assert.deepEqual(pedidos.map((p) => [p.slug, p.voz]), [['prueba-audioteca', 'trinity-clon']], 'sin duplicados')
  r = await post('/api/libros/prueba-audioteca/voces/trinity-clon', 'DELETE')
  v = (await r.json()).voces.find((x) => x.id === 'trinity-clon')
  assert.deepEqual([v.enCola, v.pedible], [false, true])
  assert.equal(JSON.parse(readFileSync(join(narrador, 'cola.json'), 'utf8')).orden.length, 1, 'cola.json no se toca')
})

test('el narrador trabajando se ve en la voz que narra', async () => {
  writeFileSync(join(narrador, 'estado.json'), JSON.stringify({
    'trabajador-0': { pid: process.pid, estado: 'narrando', libro: 'prueba-audioteca', voz: 'lector', capitulo: 2, segmentos: [30, 120] },
    'trabajador-1': { pid: 999999, estado: 'narrando', libro: 'prueba-audioteca', capitulo: 3 },
  }))
  const ficha = await (await pedir('/api/libros/prueba-audioteca')).json()
  assert.deepEqual(ficha.voces.find((x) => x.id === 'lector').narrando, [{ capitulo: 2, pct: 25 }])
  assert.deepEqual(ficha.voces.find((x) => x.id === 'lectora').narrando, [], 'un pid muerto no cuenta')
})

test('latencia: shell sellado (immutable + modulepreload), comprimido y con 304', async () => {
  const r = await pedir('/', { headers: { 'accept-encoding': 'br' } })
  assert.equal(r.headers.get('content-encoding'), 'br')
  assert.equal(r.headers.get('cache-control'), 'no-cache')
  const html = await r.text()
  const app = /src="(js\/app\.js\?h=[\w-]+)"/.exec(html)?.[1]
  assert.ok(app, 'app.js sellado en index.html')
  assert.ok((html.match(/rel="modulepreload"/g) || []).length >= 6, 'precarga todos los módulos')
  const js = await pedir('/' + app)
  assert.equal(js.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  assert.match(await js.text(), /from '\.\/api\.js\?h=[\w-]+'/, 'los imports también van sellados')
  const sinSello = await pedir('/js/app.js')
  assert.equal(sinSello.headers.get('cache-control'), 'no-cache')
  assert.equal((await pedir('/js/app.js', { headers: { 'if-none-match': sinSello.headers.get('etag') } })).status, 304)
  const datos = await pedir('/api/libros/prueba-audioteca', { headers: { 'accept-encoding': 'gzip, br' } })
  assert.equal(datos.headers.get('content-encoding'), 'br')
  assert.match(datos.headers.get('server-timing'), /app;dur=/)
  assert.equal((await pedir('/api/libros/prueba-audioteca', { headers: { 'if-none-match': datos.headers.get('etag') } })).status, 304)
})

test('capítulo alineado: cada segmento cae en su texto', async () => {
  const cap = await (await pedir('/api/libros/prueba-audioteca/capitulos/01')).json()
  assert.equal(cap.titulo, 'La condición del hidalgo')
  const tramos = cap.bloques.flatMap((b) => b.tramos)
  const de = (s) => tramos.filter((t) => t[1] === s).map((t) => t[0]).join('').trim()
  assert.equal(de(1), 'En un lugar de la Mancha vivía un hidalgo.')
  assert.equal(cap.segmentos.length, new Set(tramos.map((t) => t[1]).filter((s) => s >= 0)).size)
  const solo = await (await pedir('/api/libros/prueba-audioteca/capitulos/03')).json()
  assert.equal(solo.audio, false)
})

test('palabras exactas: cada [t0, t1, b, desde, hasta] pinta su palabra; sin alineación, [] y a la cola', async () => {
  const cap = await (await pedir('/api/libros/prueba-audioteca/capitulos/01?voz=lectora')).json()
  const alineadas = JSON.parse(readFileSync(join(datos, 'palabras/prueba-audioteca/lectora/01.json'), 'utf8')).segmentos.flat()
  assert.equal(cap.palabras.length, alineadas.length)
  const textos = cap.bloques.map((b) => b.tramos.map((t) => t[0]).join(''))
  cap.palabras.forEach(([t0, t1, b, desde, hasta], k) => {
    assert.equal(textos[b].slice(desde, hasta), alineadas[k][0])
    assert.ok(t1 >= t0 && (k === 0 || t0 >= cap.palabras[k - 1][0]))
  })
  assert.deepEqual(cap.palabras[0].slice(2), [0, 0, 2]) // «El» del título
  const juan = await (await pedir('/api/libros/prueba-audioteca/capitulos/01?voz=lector')).json()
  assert.deepEqual(juan.palabras, [])
  const cola = JSON.parse(readFileSync(join(datos, 'palabras/prioridad.json'), 'utf8'))
  assert.deepEqual(cola.filter((e) => e.slug === 'prueba-audioteca'), [{ slug: 'prueba-audioteca', voz: 'lector', nn: '01' }])
  const sinAudio = await (await pedir('/api/libros/prueba-audioteca/capitulos/03')).json()
  assert.deepEqual(sinAudio.palabras, [])
})

test('audio con Range (206), suffix range y 416', async () => {
  let r = await pedir('/api/libros/prueba-audioteca/audio/lectora/01.mp3', { headers: { range: 'bytes=0-1' } })
  assert.equal(r.status, 206)
  assert.match(r.headers.get('content-range'), /^bytes 0-1\/\d+$/)
  assert.equal((await r.arrayBuffer()).byteLength, 2)
  const total = Number(r.headers.get('content-range').split('/')[1])
  r = await pedir('/api/libros/prueba-audioteca/audio/lectora/01.mp3', { headers: { range: 'bytes=-100' } })
  assert.equal(r.headers.get('content-range'), `bytes ${total - 100}-${total - 1}/${total}`)
  r = await pedir('/api/libros/prueba-audioteca/audio/lectora/01.mp3', { headers: { range: `bytes=${total + 5}-` } })
  assert.equal(r.status, 416)
  r = await pedir('/api/libros/prueba-audioteca/audio/01.mp3')
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'audio/mpeg')
})

test('no hay forma de salir de la carpeta de libros', async () => {
  for (const r of [
    '/api/libros/..%2Fsecreto-fuera.txt', '/api/libros/../secreto-fuera.txt', '/api/libros/prueba-audioteca/audio/..%2F..%2Flibro.json',
    '/api/libros/prueba-audioteca/capitulos/..', '/%2e%2e/%2e%2e/server/sesion.mjs', '/../server/index.mjs', '/api/libros/sin-ficha',
  ]) {
    const res = await pedir(r)
    assert.ok([400, 404].includes(res.status), `${r} → ${res.status}`)
    assert.ok(!(await res.text()).includes('no debe salir'))
  }
})

test('progreso: valida, guarda y gana el más reciente', async () => {
  const put = (b) => pedir('/api/progreso/prueba-audioteca', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
  assert.equal((await put({ cap: 0, t: 1, ts: 1 })).status, 400)
  assert.equal((await put({ cap: 2, t: 12.34, vel: 2.5, voz: 'lector', ts: 2000 })).status, 200)
  await put({ cap: 1, t: 1, ts: 1000 })
  const todo = await (await pedir('/api/progreso')).json()
  assert.deepEqual(todo['prueba-audioteca'], { cap: 2, t: 12.3, vel: 2.5, voz: 'lector', ts: 2000 })
})
