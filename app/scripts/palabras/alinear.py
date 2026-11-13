"""Tiempos exactos por palabra para la Audioteca (Qwen3-ForcedAligner vía mlx_audio).

Por cada capítulo narrado (audio/<voz>/NN.mp3 + NN.json, y el v1 audio/NN.*) escribe
<datos>/palabras/<slug>/<voz>/<NN>.json con el contrato v1:
  {"v":1,"modelo":…,"fuente":{"json":<sha1 16 hex del NN.json>,"mp3":<bytes>},"segmentos":[[[palabra,t0,t1],…],…]}
segmentos[i] ↔ segmentos[i] del narrador; segundos absolutos del capítulo, no decrecientes.

Corre con el entorno de IA del repo (requirements-ia.txt):  ./audioteca palabras [--dry-run] [--solo slug --caps 1,2]
Carpetas y voces salen del .env (pipeline/config.py), igual que el servidor y el narrador.
Solo lee la carpeta de libros. Nunca dos corridas a la vez (candado en <datos>/palabras/.lock).
"""
import argparse
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'pipeline'))
import config  # noqa: E402  (pipeline/config.py: lee el .env de la raíz del repo)

LIBROS = config.LIBROS
DATOS = config.ruta('AUDIOTECA_DATOS', '.data')
ESTADO_NARRADOR = config.NARRADOR / 'estado.json'
MODELO = config.valor('AUDIOTECA_MODELO_ALINEADOR', 'mlx-community/Qwen3-ForcedAligner-0.6B-8bit')
SR = 16000
MARGEN = 0.15  # s de audio a cada lado del segmento
SLUG = re.compile(r'^[a-z0-9][a-z0-9-]{0,120}$')
VOZ = re.compile(r'^[a-z0-9][a-z0-9-]{0,60}$')
VOZ_DEFECTO = config.VOZ_DEFECTO
VOZ_PREFERIDA = config.valor('AUDIOTECA_VOZ_PREFERIDA', '')  # la misma que usa la app (vacío = la del libro)
MAX_PRIORIDAD = 50


def log(*a):
    print(time.strftime('%Y-%m-%d %H:%M:%S'), *a, flush=True)


def leer_json(ruta):
    try:
        return json.loads(Path(ruta).read_text('utf8'))
    except Exception:
        return None


def escribir_atomico(ruta, valor):
    ruta = Path(ruta)
    ruta.parent.mkdir(parents=True, exist_ok=True)
    tmp = ruta.with_name(f'.{ruta.name}.{os.getpid()}.tmp')
    tmp.write_text(json.dumps(valor, ensure_ascii=False, separators=(',', ':')), 'utf8')
    os.replace(tmp, ruta)


# Igual que ForceAlignProcessor.clean_token: letras, dígitos y apóstrofo.
def limpiar(token):
    return ''.join(c for c in token if c == "'" or unicodedata.category(c)[0] in 'LN')


def tokens(texto):
    return [t for t in (limpiar(w) for w in str(texto or '').split()) if t]


def fuente(json_ruta, mp3_ruta):
    return {'json': hashlib.sha1(Path(json_ruta).read_bytes()).hexdigest()[:16], 'mp3': Path(mp3_ruta).stat().st_size}


# ── Inventario ────────────────────────────────────────────────────────────────

def narraciones(dir_libro):
    """[(voz, n, mp3, json)] de un libro: v2 audio/<voz>/NN.* y v1 audio/NN.* (voz de su json o la del libro)."""
    meta = leer_json(dir_libro / 'libro.json')
    if not isinstance(meta, dict):
        return None
    voz_libro = meta.get('voz') if isinstance(meta.get('voz'), str) and VOZ.match(meta.get('voz')) else VOZ_DEFECTO
    audio = dir_libro / 'audio'
    vistos, out = set(), []

    def poner(voz, n, mp3, js):
        try:
            if mp3.stat().st_size <= 0 or not js.is_file():
                return
        except OSError:
            return
        if (voz, n) in vistos:
            return
        vistos.add((voz, n))
        out.append((voz, n, mp3, js))

    try:
        entradas = sorted(audio.iterdir())
    except OSError:
        return None
    for d in entradas:
        if d.is_dir() and VOZ.match(d.name):
            for f in sorted(d.iterdir()):
                m = re.match(r'^(\d{2,3})\.mp3$', f.name)
                if m:
                    poner(d.name, int(m.group(1)), f, d / f'{m.group(1)}.json')
    for f in entradas:
        m = f.is_file() and re.match(r'^(\d{2,3})\.mp3$', f.name)
        if m:
            js = audio / f'{m.group(1)}.json'
            v = (leer_json(js) or {}).get('voz')
            poner(v if isinstance(v, str) and VOZ.match(v) else voz_libro, int(m.group(1)), f, js)
    return out, voz_libro


def ruta_palabras(slug, voz, n):
    return DATOS / 'palabras' / slug / voz / f'{n:02d}.json'


def vigente(slug, voz, n, mp3, js):
    p = leer_json(ruta_palabras(slug, voz, n))
    try:
        return isinstance(p, dict) and p.get('v') == 1 and p.get('fuente') == fuente(js, mp3)
    except OSError:
        return False


def duracion(js):
    d = leer_json(js) or {}
    segs = d.get('segmentos') or []
    return float(d.get('duracion_s') or (segs[-1].get('fin') if segs else 0) or 0)


def inventario():
    """slug → {'voz': voz del libro, 'caps': {(voz, n): (mp3, json)}}."""
    libros = {}
    try:
        dirs = sorted(p for p in LIBROS.iterdir() if p.is_dir() and SLUG.match(p.name))
    except OSError:
        return {}
    for d in dirs:
        r = narraciones(d)
        if not r:
            continue
        lista, voz_libro = r
        if lista:
            libros[d.name] = {'voz': voz_libro, 'caps': {(v, n): (mp3, js) for v, n, mp3, js in lista}}
    return libros


def orden(libros, solo=None, caps=None, voz_sola=None):
    """Claves (slug, voz, n) en el orden de trabajo: prioridad → libro en curso → por recencia → el resto."""
    salida, vistos = [], set()

    def agregar(slug, voz, n):
        k = (slug, voz, n)
        if k in vistos or slug not in libros or (voz, n) not in libros[slug]['caps']:
            return
        if solo and slug != solo or caps and n not in caps or voz_sola and voz != voz_sola:
            return
        vistos.add(k)
        salida.append(k)

    def libro_entero(slug, cap=1, voz=None):
        info = libros.get(slug)
        if not info:
            return
        ns = sorted({n for _, n in info['caps']})
        adelante = [n for n in ns if n >= cap] + [n for n in reversed(ns) if n < cap]
        # La voz que va a sonar primero: la elegida a mano o, si no, la misma regla que la app (vozPorOmision en
        # public/js/voces.js): la preferida si la tiene al menos tan completa como la voz del libro.
        cuenta = lambda x: sum(1 for v, _ in info['caps'] if v == x)
        omision = VOZ_PREFERIDA if VOZ_PREFERIDA and cuenta(VOZ_PREFERIDA) and cuenta(VOZ_PREFERIDA) >= cuenta(info['voz']) else info['voz']
        principal = voz if voz and any(v == voz for v, _ in info['caps']) else omision
        voces = [principal] + sorted({v for v, _ in info['caps']} - {principal})
        for v in voces:
            for n in adelante:
                agregar(slug, v, n)

    pri = leer_json(DATOS / 'palabras' / 'prioridad.json')
    for e in pri if isinstance(pri, list) else []:
        try:
            agregar(str(e['slug']), str(e['voz']), int(e['nn']))
        except Exception:
            pass
    prog = leer_json(DATOS / 'progreso.json')
    prog = prog if isinstance(prog, dict) else {}
    recientes = sorted((s for s in prog if isinstance(prog[s], dict)), key=lambda s: -float(prog[s].get('ts') or 0))
    for s in recientes:
        p = prog[s]
        try:
            cap = int(p.get('cap') or 1)
        except Exception:
            cap = 1
        libro_entero(s, cap, p.get('voz'))
    # El resto: lo narrado más recientemente primero (lo nuevo es lo próximo que se escucha).
    def mtime(slug):
        return max((mp3.stat().st_mtime for mp3, _ in libros[slug]['caps'].values()), default=0)
    for s in sorted(libros, key=lambda s: -mtime(s)):
        libro_entero(s)
    return salida


def _int(x):
    try:
        return int(x)
    except Exception:
        return None


def quitar_prioridad(slug, voz, n):
    ruta = DATOS / 'palabras' / 'prioridad.json'
    pri = leer_json(ruta)
    if not isinstance(pri, list):
        return
    resto = []
    for e in pri:
        try:
            if (str(e['slug']), str(e['voz']), int(e['nn'])) == (slug, voz, n):
                continue
        except Exception:
            continue
        resto.append(e)
    if len(resto) != len(pri):
        escribir_atomico(ruta, resto[:MAX_PRIORIDAD])


def narrador_ocupado():
    e = leer_json(ESTADO_NARRADOR) or {}
    return any(k.startswith('trabajador-') and isinstance(v, dict) and v.get('estado') == 'narrando' for k, v in e.items())


# ── Alineación ────────────────────────────────────────────────────────────────

_alineador = None


def alineador():
    global _alineador
    if _alineador is None:
        t0 = time.time()
        from mlx_audio.stt.utils import load_model
        _alineador = load_model(MODELO)
        log(f'modelo cargado en {time.time() - t0:.1f}s')
    return _alineador


def decodificar(mp3):
    import numpy as np
    pcm = subprocess.run(['ffmpeg', '-v', 'error', '-nostdin', '-i', str(mp3), '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'],
                         capture_output=True, check=True).stdout
    return np.frombuffer(pcm, dtype=np.float32)


def repartir(toks, items):
    """Texto ↔ items del aligner. Si el número no cuadra, reparto proporcional por índice (sin perder palabras)."""
    if not items:
        return []
    if len(items) == len(toks):
        return [(w, it.start_time, it.end_time) for w, it in zip(toks, items)]
    n = len(toks)
    return [(w, items[min(len(items) - 1, int(i * len(items) / n))].start_time,
             items[min(len(items) - 1, int(i * len(items) / n))].end_time) for i, w in enumerate(toks)]


def alinear_capitulo(mp3, js):
    datos = leer_json(js)
    segs = (datos or {}).get('segmentos')
    if not isinstance(segs, list):
        raise ValueError('json del narrador ilegible')
    audio = decodificar(mp3)
    largo = len(audio) / SR
    al = alineador()
    salida, previo, fallos, desiguales = [], 0.0, 0, 0
    for s in segs:
        texto = s.get('texto') if isinstance(s, dict) else None
        toks = tokens(texto)
        try:
            ini, fin = float(s.get('inicio') or 0), float(s.get('fin') or 0)
        except Exception:
            ini, fin = 0.0, 0.0
        if not toks or fin <= ini:
            salida.append([])
            continue
        a, b = max(0.0, ini - MARGEN), min(largo, fin + MARGEN)
        recorte = audio[int(a * SR):int(b * SR)]
        if len(recorte) < SR // 10:
            salida.append([])
            continue
        try:
            r = al.generate(recorte, text=texto, language='Spanish')
            items = list(r.items)
        except Exception as e:  # un segmento raro no tumba el capítulo
            fallos += 1
            log(f'  ! segmento {s.get("i")}: {type(e).__name__}: {e}')
            salida.append([])
            continue
        if items and len(items) != len(toks):
            desiguales += 1
        palabras = []
        for w, t0, t1 in repartir(toks, items):
            t0 = min(max(a + float(t0), ini, previo), fin)
            t1 = min(max(a + float(t1), t0), fin)
            previo = t1
            palabras.append([w, round(t0, 3), round(t1, 3)])
        salida.append(palabras)
    return salida, largo, fallos, desiguales


# ── Principal ─────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--solo', help='solo este libro (slug)')
    ap.add_argument('--caps', help='capítulos, p. ej. 1,2,3 (con --solo)')
    ap.add_argument('--voz', help='solo esta voz')
    ap.add_argument('--max-min', type=float, default=0, help='no empezar capítulos nuevos tras N minutos')
    ap.add_argument('--dry-run', action='store_true', help='lista lo pendiente y cuánto audio suma')
    args = ap.parse_args()
    caps = {int(x) for x in args.caps.split(',') if x.strip()} if args.caps else None

    (DATOS / 'palabras').mkdir(parents=True, exist_ok=True)
    candado = open(DATOS / 'palabras' / '.lock', 'w')
    try:
        fcntl.flock(candado, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        log('otra corrida tiene el candado; salgo')
        return 0

    def pendientes(saltar=()):
        libros = inventario()
        out = []
        for slug, voz, n in orden(libros, args.solo, caps, args.voz):
            if (slug, voz, n) in saltar:
                continue
            mp3, js = libros[slug]['caps'][(voz, n)]
            if not vigente(slug, voz, n, mp3, js):
                out.append((slug, voz, n, mp3, js))
        return out

    lista = pendientes()
    total = sum(duracion(js) for *_, js in lista)
    if args.dry_run:
        for slug, voz, n, mp3, js in lista:
            print(f'{slug}/{voz}/{n:02d}  {duracion(js) / 60:6.1f} min')
        print(f'{len(lista)} capítulos pendientes · {total / 3600:.1f} h de audio')
        return 0
    ruta_pri = DATOS / 'palabras' / 'prioridad.json'
    if not lista:
        # Lo que quede en la cola ya no existe o ya está vigente.
        if (leer_json(ruta_pri) or []) != []:
            escribir_atomico(ruta_pri, [])
        return 0
    # Fuera de la cola lo que ya no existe o ya está vigente (si no, nunca saldría).
    pri = leer_json(ruta_pri)
    if isinstance(pri, list) and not (args.solo or args.voz):
        claves = {(sl, v, n) for sl, v, n, *_ in lista}
        resto = [e for e in pri if isinstance(e, dict) and (str(e.get('slug')), str(e.get('voz')), _int(e.get('nn'))) in claves]
        if len(resto) != len(pri):
            escribir_atomico(ruta_pri, resto)
    log(f'{len(lista)} capítulos pendientes · {total / 3600:.1f} h de audio')
    inicio = time.time()
    hechos, intentados = 0, set()
    while lista:
        if args.max_min and time.time() - inicio > args.max_min * 60:
            log(f'tope de {args.max_min:g} min; sigo en la próxima corrida')
            break
        slug, voz, n, mp3, js = lista[0]
        intentados.add((slug, voz, n))
        try:
            antes = fuente(js, mp3)
        except OSError:
            lista = pendientes(intentados)
            continue
        t0 = time.time()
        try:
            segmentos, largo, fallos, desiguales = alinear_capitulo(mp3, js)
        except Exception as e:
            log(f'✗ {slug}/{voz}/{n:02d}: {type(e).__name__}: {e}')
            quitar_prioridad(slug, voz, n)
            lista = pendientes(intentados)
            continue
        dt = time.time() - t0
        try:
            despues = fuente(js, mp3)
        except OSError:
            despues = None
        if despues != antes:
            log(f'~ {slug}/{voz}/{n:02d}: el narrador lo rehízo mientras alineaba; queda pendiente')
        else:
            escribir_atomico(ruta_palabras(slug, voz, n), {'v': 1, 'modelo': MODELO, 'fuente': antes, 'segmentos': segmentos})
            quitar_prioridad(slug, voz, n)
            hechos += 1
            np_ = sum(len(s) for s in segmentos)
            log(f'✓ {slug}/{voz}/{n:02d}: {len(segmentos)} oraciones, {np_} palabras, {largo / 60:.1f} min de audio en {dt:.1f}s '
                f'({largo / dt:.0f}× tiempo real){f", {fallos} fallos" if fallos else ""}{f", {desiguales} repartidos" if desiguales else ""}')
        if narrador_ocupado():
            log(f'  el narrador está narrando: descanso {dt:.0f}s')
            time.sleep(dt)
        # Se recalcula tras cada capítulo: lo que abriste mientras tanto (prioridad.json) pasa al frente.
        lista = pendientes(intentados)
    log(f'listo: {hechos} capítulos en {(time.time() - inicio) / 60:.1f} min')
    return 0


if __name__ == '__main__':
    sys.exit(main())
