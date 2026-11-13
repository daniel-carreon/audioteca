// Varias voces por libro (docs/FORMATO.md). Eliges una voz por libro; cada capítulo suena en esa voz si ya
// la tiene y, si todavía no llega ahí, en la voz del libro u otra que lo tenga (sin pantalla a la mano, mejor seguir
// sonando que quedarse callado). Cambiar de voz conserva la oración: los segmentos de dos narraciones se
// alinean contra el MISMO texto, así que la oración se ubica por su lugar en el texto, no por su número.

/** Las descargas y fichas de antes de v2 no traían voz: entonces solo existía una voz (la de macOS en esta versión). */
export const VOZ_V1 = 'macos'


/** Capítulos narrados por voz. Sirve con la ficha (capitulos[].narraciones) y con la lista (versiones: [n, v, voz]). */
function capitulosPorVoz(ficha) {
  const cuenta = {}
  if (Array.isArray(ficha.capitulos)) {
    for (const c of ficha.capitulos) for (const v of Object.keys(c.narraciones || {})) cuenta[v] = (cuenta[v] || 0) + 1
  } else {
    for (const [, , v] of ficha.versiones || []) if (v) cuenta[v] = (cuenta[v] || 0) + 1
  }
  return cuenta
}

/** Lo que suena si no elegiste voz para ese libro: la voz preferida (AUDIOTECA_VOZ_PREFERIDA, llega en la ficha como
 *  `voz_preferida`) cuando la tiene narrada al menos tanto como la voz del libro (así no se brinca de voz entre
 *  capítulos); si no, la voz del libro. Una voz elegida a mano siempre manda. */
export function vozPorOmision(ficha) {
  const preferida = ficha.voz_preferida
  if (!preferida) return ficha.voz
  const cuenta = capitulosPorVoz(ficha)
  const pref = cuenta[preferida] || 0
  return pref > 0 && pref >= (cuenta[ficha.voz] || 0) ? preferida : ficha.voz
}

/** La ficha vista con la voz elegida: campos planos (audio, duracion, bytes, v, voz) de lo que va a sonar. */
export function conVoz(ficha, elegida) {
  const voz = elegida || vozPorOmision(ficha)
  const capitulos = ficha.capitulos.map((c) => {
    const narr = c.narraciones || (c.audio ? { [c.voz || ficha.voz || VOZ_V1]: { d: c.duracion, b: c.bytes, v: c.v } } : {})
    const v = [voz, ficha.voz, ...Object.keys(narr)].find((x) => x && narr[x]) || null
    const e = v ? narr[v] : null
    return { ...c, narraciones: narr, audio: !!e, duracion: e ? e.d : 0, bytes: e ? e.b : 0, v: e ? e.v : null, voz: v, otraVoz: !!v && v !== voz }
  })
  return {
    ...ficha,
    capitulos,
    vozElegida: voz,
    narrados: capitulos.filter((c) => c.audio).length,
    duracion: Math.round(capitulos.reduce((a, c) => a + c.duracion, 0)),
  }
}

/** Voces con algo narrado de ese libro (las que se pueden elegir). */
export const vocesConAudio = (ficha) => (ficha.voces || []).filter((v) => v.narrados > 0)

export const nombreVoz = (ficha, id) => (ficha.voces || []).find((v) => v.id === id)?.nombre || (id || '').replace(/-clon$/, '').replace(/^./, (c) => c.toUpperCase())

/** Segmento que suena en `t` (búsqueda binaria sobre los inicios). */
export function segmentoEn(t, segs) {
  let lo = 0
  let hi = segs.length - 1
  let r = -1
  while (lo <= hi) {
    const m = (lo + hi) >> 1
    if (segs[m][0] <= t + 0.04) { r = m; lo = m + 1 } else hi = m - 1
  }
  return r
}

/** Primer carácter de cada segmento en el texto: Map segmento → [bloque, desplazamiento]. */
function lugares(bloques) {
  const out = new Map()
  bloques.forEach((b, bi) => {
    let o = 0
    for (const [texto, s] of b.tramos) {
      if (s >= 0 && !out.has(s)) out.set(s, [bi, o])
      o += texto.length
    }
  })
  return out
}

/** Segmento que narra el carácter (bloque, desplazamiento), o el siguiente narrado si ese no lo está. */
function segmentoEnLugar(bloques, bi, o) {
  for (let b = bi; b < bloques.length; b++) {
    let pos = 0
    for (const [texto, s] of bloques[b].tramos) {
      if (s >= 0 && (b > bi || pos + texto.length > o)) return s
      pos += texto.length
    }
  }
  return -1
}

/** Tiempo en `capNuevo` equivalente a `t` en `capViejo`: la misma oración y la misma fracción dentro de ella. */
export function tiempoEquivalente(capViejo, t, capNuevo) {
  const viejos = capViejo?.segmentos || []
  const nuevos = capNuevo?.segmentos || []
  if (!nuevos.length) return 0
  const i = segmentoEn(t, viejos)
  if (i < 0) return 0
  const lugar = lugares(capViejo.bloques).get(i)
  let j = lugar ? segmentoEnLugar(capNuevo.bloques, lugar[0], lugar[1]) : -1
  if (j < 0) j = Math.min(nuevos.length - 1, Math.round((i * nuevos.length) / Math.max(1, viejos.length)))
  const [a, b] = viejos[i]
  const frac = b > a ? Math.min(1, Math.max(0, (t - a) / (b - a))) : 0
  const [c, d] = nuevos[j]
  return Math.max(0, c + frac * Math.max(0, d - c))
}
