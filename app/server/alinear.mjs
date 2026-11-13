// Texto del capítulo (texto/NN.md) + segmentos del narrador (audio/NN.json) → bloques listos para pintar,
// con cada tramo marcado con el segmento que lo narra. Es lo que permite resaltar la oración en curso y
// saltar el audio al tocar una oración.
//
// El narrador corta el mismo texto en oraciones, pero no es garantía de igualdad literal (puede deletrear
// cifras, limpiar comillas, unir párrafos). Por eso se alinea sobre una versión normalizada (solo letras y
// dígitos, sin acentos, en minúsculas) en dos pasadas: anclas exactas en orden, y los segmentos que no
// casan se reparten proporcionalmente entre sus anclas vecinas. Un desajuste local nunca arrastra al resto.

const ES_ALNUM = /[\p{L}\p{N}]/u
const APERTURA = new Set(['¿', '¡', '«', '“', '"', '(', '[', '‘', "'", '—'])

export function normalizarCaracter(c) {
  return c.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

export function normalizar(texto) {
  let s = ''
  for (const c of texto) if (ES_ALNUM.test(c)) s += normalizarCaracter(c)
  return s
}

/** Quita marcas de énfasis Markdown y devuelve el texto plano con la marca de cada carácter. */
export function inline(texto) {
  let plano = ''
  const marcas = []
  const re = /(\*\*|__)(.+?)\1|(\*|_)(?=\S)(.+?)(?<=\S)\3/g
  let ultimo = 0
  for (const m of texto.matchAll(re)) {
    const antes = texto.slice(ultimo, m.index)
    plano += antes
    marcas.push(...Array(antes.length).fill(null))
    const dentro = m[2] ?? m[4]
    plano += dentro
    marcas.push(...Array(dentro.length).fill(m[1] ? 'strong' : 'em'))
    ultimo = m.index + m[0].length
  }
  const resto = texto.slice(ultimo)
  plano += resto
  marcas.push(...Array(resto.length).fill(null))
  return { plano, marcas }
}

/** Markdown de texto/NN.md → { titulo, bloques: [{ tipo: 'h1'|'h2'|'p'|'q'|'li', plano, marcas }] }. */
export function parsearMarkdown(md) {
  const bloques = []
  let titulo = null
  let parrafo = []
  let tipoParrafo = 'p'
  const cerrar = () => {
    if (parrafo.length) bloques.push({ tipo: tipoParrafo, ...inline(parrafo.join(' ').replace(/\s+/g, ' ').trim()) })
    parrafo = []
    tipoParrafo = 'p'
  }
  for (const crudo of md.replace(/\r\n?/g, '\n').split('\n')) {
    const linea = crudo.trim()
    if (!linea) { cerrar(); continue }
    const h = /^(#{1,6})\s+(.*)$/.exec(linea)
    if (h) {
      cerrar()
      const tipo = h[1].length === 1 ? 'h1' : 'h2'
      if (tipo === 'h1' && titulo === null) titulo = h[2].replace(/[*_]/g, '').trim()
      bloques.push({ tipo, ...inline(h[2].trim()) })
      continue
    }
    if (/^([-*_])\1{2,}$/.test(linea)) { cerrar(); continue } // separador ---
    const q = /^>\s?(.*)$/.exec(linea)
    const li = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(linea)
    if (q) { if (tipoParrafo !== 'q') cerrar(); tipoParrafo = 'q'; parrafo.push(q[1]); continue }
    if (li) { cerrar(); tipoParrafo = 'li'; parrafo.push(li[1]); cerrar(); continue }
    parrafo.push(linea)
  }
  cerrar()
  return { titulo, bloques }
}

/** Devuelve, para cada segmento, su rango [inicio, fin) sobre el flujo normalizado. */
export function anclar(flujo, textos) {
  return anclarConTipo(flujo, textos).rangos
}

/**
 * Como `anclar`, y además cómo se ancló cada segmento: 'exacto' (su texto normalizado está tal cual),
 * 'cabeza' (solo casó el arranque) o null (repartido entre vecinos: su sitio es una estimación).
 */
export function anclarConTipo(flujo, textos) {
  const qs = textos.map(normalizar)
  const rangos = new Array(qs.length).fill(null)
  const tipos = new Array(qs.length).fill(null)
  let cursor = 0
  let pendiente = 0
  qs.forEach((q, k) => {
    if (!q) return
    // Un segmento cortito («2.», «Sí.») casa en cualquier parte: solo vale si está pegado a lo anterior; si no,
    // se reparte (el «1.» de una lista lo dice el narrador pero el Markdown lo quita del texto).
    const ventana = q.length < 6 ? 12 : 400 + q.length * 3 + pendiente * 2
    let idx = flujo.indexOf(q, cursor)
    if (idx < 0 || idx - cursor > ventana) {
      // Ancla parcial: el arranque de la oración suele sobrevivir aunque el final cambie.
      const cabeza = q.slice(0, Math.min(24, q.length))
      const j = cabeza.length >= 8 ? flujo.indexOf(cabeza, cursor) : -1
      if (j >= 0 && j - cursor <= ventana) {
        rangos[k] = [j, Math.min(flujo.length, j + q.length)]
        tipos[k] = 'cabeza'
        cursor = rangos[k][1]
        pendiente = 0
      } else {
        pendiente += q.length
      }
      return
    }
    rangos[k] = [idx, idx + q.length]
    tipos[k] = 'exacto'
    cursor = idx + q.length
    pendiente = 0
  })
  // Segunda pasada: repartir los huecos entre anclas vecinas en proporción al largo de cada segmento.
  let k = 0
  while (k < qs.length) {
    if (rangos[k] || !qs[k]) { k++; continue }
    let fin = k
    while (fin < qs.length && !rangos[fin]) fin++
    const desde = k > 0 && rangos[k - 1] ? rangos[k - 1][1] : 0
    const total = qs.slice(k, fin).reduce((a, q) => a + q.length, 0) || 1
    const hasta = fin < qs.length ? rangos[fin][0] : Math.min(flujo.length, desde + Math.ceil(total * 1.1))
    let pos = desde
    for (let m = k; m < fin; m++) {
      const largo = Math.round(((hasta - desde) * qs[m].length) / total)
      rangos[m] = [pos, m === fin - 1 ? hasta : pos + largo]
      pos = rangos[m][1]
    }
    k = fin
  }
  return { rangos, tipos }
}

/**
 * Palabras alineadas (por segmento: [[texto, t0, t1], ...]) → [[t0, t1, b, desde, hasta]] ordenadas por t0.
 *
 * Segmento con ancla exacta: la palabra k ocupa, dentro de su rango normalizado, el tramo acumulado de
 * normalizar(texto) (escalado si el rango no mide lo mismo). Segmento sin ancla exacta (el narrador dijo el «1.»
 * de una lista, deletreó una cifra, cambió el final): cada palabra se busca letra a letra en el texto, entre
 * las anclas exactas vecinas, cerca de donde la pone la estimación; la que no aparece se descarta (no se
 * inventa). También se descartan las que caerían en dos bloques.
 */
const HOLGURA = 6 // letras de más que el texto puede tener entre dos palabras dichas seguidas
const VECINDAD = 240 // alrededor de la estimación, dónde buscar el arranque de un segmento sin ancla

function buscarCerca(flujo, aguja, esperado, lo, hi) {
  let mejor = -1
  for (let i = flujo.indexOf(aguja, lo); i >= 0 && i + aguja.length <= hi; i = flujo.indexOf(aguja, i + 1)) {
    if (mejor < 0 || Math.abs(i - esperado) < Math.abs(mejor - esperado)) mejor = i
    if (i > esperado) break
  }
  return mejor
}

function resincronizar(flujo, ns, r, lo, hi, escala) {
  const pos = new Array(ns.length).fill(null)
  let cursor = null
  let fallos = 0
  let acum = 0
  ns.forEach((n, k) => {
    const esperado = r[0] + Math.round(acum * escala)
    acum += n.length
    if (!n) return
    if (cursor === null) {
      // Arranque: esta palabra y las siguientes juntas (≥ 8 letras o 3 palabras), lo más cerca de lo esperado.
      let aguja = n
      for (let m = k + 1; m < ns.length && aguja.length < 8 && m < k + 3; m++) aguja += ns[m]
      let i = aguja.length < 4 ? -1 : buscarCerca(flujo, aguja, esperado, Math.max(lo, esperado - VECINDAD), Math.min(hi, esperado + VECINDAD + aguja.length))
      // Si la siguiente es justo la que cambió (cifra deletreada), la palabra sola, pegada a la estimación.
      if (i < 0 && n.length >= 2) i = buscarCerca(flujo, n, esperado, Math.max(lo, esperado - HOLGURA), Math.min(hi, esperado + HOLGURA + n.length))
      if (i < 0) return
      pos[k] = [i, i + n.length]
      cursor = i + n.length
      fallos = 0
      return
    }
    const i = flujo.indexOf(n, cursor)
    if (i >= 0 && i - cursor <= HOLGURA && i + n.length <= hi) {
      pos[k] = [i, i + n.length]
      cursor = i + n.length
      fallos = 0
    } else if (++fallos >= 2) {
      cursor = null // perdió el hilo: vuelve a anclar con las siguientes
    }
  })
  return pos
}

function mapearPalabras(flujo, mapa, planos, rangos, tipos, palabrasPorSeg) {
  const salida = []
  // Límites de búsqueda para los segmentos sin ancla exacta: el fin del exacto anterior y el inicio del siguiente.
  const limiteAntes = []
  let ultimo = 0
  rangos.forEach((r, s) => { limiteAntes[s] = ultimo; if (r && tipos[s] === 'exacto') ultimo = r[1] })
  const limiteDespues = []
  let siguiente = flujo.length
  for (let s = rangos.length - 1; s >= 0; s--) { limiteDespues[s] = siguiente; if (rangos[s] && tipos[s] === 'exacto') siguiente = rangos[s][0] }

  palabrasPorSeg.forEach((lista, s) => {
    const r = rangos[s]
    if (!Array.isArray(lista) || !lista.length || !r) return
    const ns = lista.map((w) => (Array.isArray(w) ? normalizar(String(w[0] ?? '')) : ''))
    const total = ns.reduce((a, x) => a + x.length, 0)
    if (!total) return
    const ancho = r[1] - r[0]
    const escala = ancho === total ? 1 : ancho / total
    let pos
    if (tipos[s] === 'exacto') {
      pos = []
      let acum = 0
      for (const n of ns) {
        const p = r[0] + Math.round(acum * escala)
        acum += n.length
        pos.push(n ? [p, r[0] + Math.round(acum * escala)] : null)
      }
    } else {
      pos = resincronizar(flujo, ns, r, limiteAntes[s], limiteDespues[s], escala)
    }
    lista.forEach((w, k) => {
      if (!pos[k]) return
      const [p, e] = pos[k]
      const t0 = Number(w[1])
      const t1 = Number(w[2])
      if (!Number.isFinite(t0) || !Number.isFinite(t1) || e <= p || e > mapa.length) return
      const [b0, c0] = mapa[p]
      const [b1, c1] = mapa[e - 1]
      if (b0 !== b1) return
      const cp = planos[b1].codePointAt(c1)
      salida.push([t0, Math.max(t0, t1), b0, c0, c1 + (cp > 0xffff ? 2 : 1)])
    })
  })
  return salida.sort((a, b) => a[0] - b[0])
}

/**
 * Alinea y produce lo que pinta el cliente:
 * bloques: [{ tipo, tramos: [[texto, segmento|-1, marca?]] }]
 * palabras: [[t0, t1, b, desde, hasta]] si llegan las palabras alineadas de cada segmento (si no, []).
 */
export function alinearCapitulo(md, segmentos = [], palabrasPorSeg = null) {
  const { titulo, bloques } = parsearMarkdown(md)
  const mapa = [] // posición en el flujo → [bloque, carácter]
  let flujo = ''
  bloques.forEach((b, bi) => {
    let ci = 0
    for (const c of b.plano) {
      if (ES_ALNUM.test(c)) {
        const n = normalizarCaracter(c)
        for (let x = 0; x < n.length; x++) mapa.push([bi, ci])
        flujo += n
      }
      ci += c.length
    }
  })
  const dueños = bloques.map((b) => new Array(b.plano.length).fill(-1))
  let palabras = []
  if (segmentos.length) {
    const { rangos, tipos } = anclarConTipo(flujo, segmentos.map((s) => s.texto || ''))
    if (Array.isArray(palabrasPorSeg)) palabras = mapearPalabras(flujo, mapa, bloques.map((b) => b.plano), rangos, tipos, palabrasPorSeg)
    rangos.forEach((r, s) => {
      if (!r) return
      for (let p = r[0]; p < r[1] && p < mapa.length; p++) {
        const [bi, ci] = mapa[p]
        dueños[bi][ci] = s
      }
    })
  }
  const salida = bloques.map((b, bi) => {
    const d = dueños[bi]
    const chars = b.plano
    // Caracteres sin letra (espacios, puntuación) heredan el dueño de sus vecinos.
    for (let i = 0; i < chars.length; i++) {
      if (ES_ALNUM.test(chars[i]) || d[i] !== -1) continue
      let a = i - 1
      while (a >= 0 && !ES_ALNUM.test(chars[a])) a--
      let z = i + 1
      while (z < chars.length && !ES_ALNUM.test(chars[z])) z++
      const prev = a >= 0 ? d[a] : -1
      const next = z < chars.length ? d[z] : -1
      if (prev === next) d[i] = prev
      else if (/\s/.test(chars[i])) d[i] = -1
      else if (APERTURA.has(chars[i])) d[i] = next
      else d[i] = prev
    }
    const tramos = []
    for (let i = 0; i < chars.length; i++) {
      const ultimo = tramos[tramos.length - 1]
      const marca = b.marcas[i] || undefined
      if (ultimo && ultimo[1] === d[i] && ultimo[2] === marca) ultimo[0] += chars[i]
      else tramos.push(marca ? [chars[i], d[i], marca] : [chars[i], d[i]])
    }
    return { tipo: b.tipo, tramos }
  })
  return { titulo, bloques: salida, palabras }
}
