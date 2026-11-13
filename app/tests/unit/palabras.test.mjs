// Mapeo palabra → [bloque, desde, hasta] (server/alinear.mjs) y vigencia de la alineación (server/libros.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { alinearCapitulo } from '../../server/alinear.mjs'
import { leerCapitulo } from '../../server/libros.mjs'
import { colaPalabras } from '../../server/index.mjs'

const raiz = join(dirname(fileURLToPath(import.meta.url)), '../..')

// Tokens como el aligner (split por espacios, letras/dígitos/apóstrofo) con tiempos inventados crecientes.
const tokens = (t) => t.split(/\s+/).map((w) => [...w].filter((c) => c === "'" || /[\p{L}\p{N}]/u.test(c)).join('')).filter(Boolean)
function alinear(md, textos) {
  let t = 0
  const segmentos = textos.map((texto) => ({ texto }))
  const porSeg = textos.map((texto) => tokens(texto).map((w) => [w, (t += 0.5) - 0.5, t - 0.1]))
  const r = alinearCapitulo(md, segmentos, porSeg)
  const planos = r.bloques.map((b) => b.tramos.map((x) => x[0]).join(''))
  return { ...r, pintado: r.palabras.map(([, , b, d, h]) => planos[b].slice(d, h)) }
}

test('acentos y mayúsculas: la palabra pinta el texto original, no el normalizado', () => {
  const { pintado, palabras } = alinear('# Título\n\nÁrbol GRANDE, ñandú.\n', ['Título', 'arbol grande, Ñandú.'])
  assert.deepEqual(pintado, ['Título', 'Árbol', 'GRANDE', 'ñandú'])
  assert.deepEqual(palabras.map((p) => p[2]), [0, 1, 1, 1])
})

test('«¿¡» y comillas quedan fuera: cada palabra cubre solo sus letras', () => {
  const { pintado, palabras } = alinear('# T\n\n¿Quién trae «carga»? ¡Nadie!\n', ['T', '¿Quién trae «carga»?', '¡Nadie!'])
  assert.deepEqual(pintado, ['T', 'Quién', 'trae', 'carga', 'Nadie'])
  assert.deepEqual(palabras[1].slice(3), [1, 6])
})

test('cifras: tal cual casan; deletreadas por el narrador, se pintan las que están en el texto y nada más', () => {
  let r = alinear('# T\n\nEn 1984 todo cambió.\n', ['T', 'En 1984 todo cambió.'])
  assert.deepEqual(r.pintado, ['T', 'En', '1984', 'todo', 'cambió'])
  r = alinear('# T\n\nEn 1984 todo cambió. Después vino la calma.\n', ['T', 'En mil novecientos ochenta y cuatro todo cambió.', 'Después vino la calma.'])
  assert.deepEqual(r.pintado, ['T', 'En', 'todo', 'cambió', 'Después', 'vino', 'la', 'calma'])
})

test('lista numerada: el «1.» que dice el narrador no está en el texto y no arrastra a las demás palabras', () => {
  const md = '# T\n\nTres etapas:\n\n1. La primera etapa es comenzar.\n2. La segunda etapa es crecer hasta USD 2 millones al año.\n'
  const r = alinear(md, ['T', 'Tres etapas:', '1.', 'La primera etapa es comenzar.', '2.', 'La segunda etapa es crecer hasta USD 2', 'millones al año.'])
  assert.deepEqual(r.pintado, ['T', 'Tres', 'etapas', 'La', 'primera', 'etapa', 'es', 'comenzar', 'La', 'segunda', 'etapa', 'es', 'crecer', 'hasta', 'USD', '2', 'millones', 'al', 'año'])
  assert.deepEqual([...new Set(r.palabras.map((p) => p[2]))], [0, 1, 2, 3])
})

test('énfasis **x**: la palabra pinta dentro del tramo marcado y puede cruzar tramos', () => {
  const r = alinear('# T\n\nHola **mundo** y **super**bueno.\n', ['T', 'Hola mundo y superbueno.'])
  assert.deepEqual(r.pintado, ['T', 'Hola', 'mundo', 'y', 'superbueno'])
  const tramos = r.bloques[1].tramos.map((t) => t[0])
  assert.ok(tramos.includes('super') && tramos.some((t) => t.startsWith('bueno')), 'superbueno ocupa dos tramos')
})

test('segmento sin ancla (texto que no está en el capítulo): sus palabras se descartan, no se inventan', () => {
  const r = alinear('# T\n\nUno dos tres. Cuatro cinco.\n', ['T', 'Uno dos tres.', 'Zeta yugo xilófono.', 'Cuatro cinco.'])
  assert.deepEqual(r.pintado, ['T', 'Uno', 'dos', 'tres', 'Cuatro', 'cinco'])
})

test('palabra que caería en dos bloques: se descarta', () => {
  const r = alinear('# T\n\nabc\n\ndef ghi\n', ['T', 'abcdef ghi'])
  assert.deepEqual(r.pintado, ['T', 'ghi'])
})

test('letras fuera del plano básico (dos unidades UTF-16): hasta cubre la letra entera', () => {
  const r = alinear('# T\n\nUn 𝐀𝐁 raro.\n', ['T', 'Un 𝐀𝐁 raro.'])
  assert.deepEqual(r.pintado, ['T', 'Un', '𝐀𝐁', 'raro'])
})

test('sin palabras alineadas: palabras = [] (el cliente cae a la oración)', () => {
  assert.deepEqual(alinearCapitulo('# T\n\nUno.\n', [{ texto: 'T' }, { texto: 'Uno.' }]).palabras, [])
  assert.deepEqual(alinearCapitulo('# T\n\nUno.\n', [], [[['T', 0, 1]]]).palabras, [])
})

test('leerCapitulo: alineación vigente se pinta; vieja (fuente distinta) → [] y pide realinear', () => {
  const libros = mkdtempSync(join(tmpdir(), 'audioteca-palabras-libros-'))
  const datos = mkdtempSync(join(tmpdir(), 'audioteca-palabras-datos-'))
  cpSync(join(raiz, 'fixtures/libros/prueba-audioteca'), join(libros, 'prueba-audioteca'), { recursive: true })
  const destino = join(datos, 'palabras/prueba-audioteca/lectora')
  mkdirSync(destino, { recursive: true })
  const fixture = JSON.parse(readFileSync(join(raiz, 'fixtures/palabras/prueba-audioteca/lectora/01.json'), 'utf8'))
  const json = readFileSync(join(libros, 'prueba-audioteca/audio/lectora/01.json'))
  assert.equal(fixture.fuente.json, createHash('sha1').update(json).digest('hex').slice(0, 16), 'el fixture corresponde al libro de prueba')
  const pedidos = []
  const pedir = (e) => pedidos.push(e)

  writeFileSync(join(destino, '01.json'), JSON.stringify(fixture))
  let cap = leerCapitulo(libros, 'prueba-audioteca', '01', 'lectora', { datos, pedir })
  assert.equal(cap.palabras.length, fixture.segmentos.flat().length)
  assert.deepEqual(pedidos, [])

  // Otra fuente (el narrador rehízo el capítulo): se ignora y se invalida la caché por el cambio del archivo.
  writeFileSync(join(destino, '01.json'), JSON.stringify({ ...fixture, fuente: { ...fixture.fuente, mp3: 1 } }))
  cap = leerCapitulo(libros, 'prueba-audioteca', '01', 'lectora', { datos, pedir })
  assert.deepEqual(cap.palabras, [])
  assert.deepEqual(pedidos, [{ slug: 'prueba-audioteca', voz: 'lectora', nn: '01' }])
  // Desde la caché también pide (la cola decide si ya lo tiene).
  leerCapitulo(libros, 'prueba-audioteca', '01', 'lectora', { datos, pedir })
  assert.equal(pedidos.length, 2)

  // Vuelve a ser vigente: se pinta sin reiniciar nada.
  writeFileSync(join(destino, '01.json'), JSON.stringify(fixture) + '\n')
  assert.equal(leerCapitulo(libros, 'prueba-audioteca', '01', 'lectora', { datos, pedir }).palabras.length, fixture.segmentos.flat().length)
})

test('cola de prioridad: al frente, sin duplicados, máximo 50, atómica', () => {
  const datos = mkdtempSync(join(tmpdir(), 'audioteca-cola-'))
  const pedir = colaPalabras(datos, { cada: 0 })
  for (let i = 1; i <= 60; i++) pedir({ slug: 'libro', voz: 'mi-voz-clon', nn: String(i).padStart(2, '0') })
  pedir({ slug: 'libro', voz: 'mi-voz-clon', nn: '60' })
  const cola = JSON.parse(readFileSync(join(datos, 'palabras/prioridad.json'), 'utf8'))
  assert.equal(cola.length, 50)
  assert.deepEqual(cola[0], { slug: 'libro', voz: 'mi-voz-clon', nn: '60' })
  assert.equal(new Set(cola.map((e) => e.nn)).size, 50)
})
