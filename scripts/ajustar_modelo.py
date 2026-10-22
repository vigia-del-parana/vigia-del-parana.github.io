#!/usr/bin/env python3
"""Calibra la Proyección Vigía y escribe data/modelo.json.

Método directo por horizonte. Para cada puerto y para cada horizonte k = 1..15 días se
estima cuánto va a cambiar su altura según cuánto subió o bajó el río en las últimas dos
semanas en él mismo y en puertos de aguas arriba:

  h_d(t+k) − h_d(t) ≈ Σ_i w_k,i · [ h_si(t−a_i) − h_si(t−b_i) ]

donde cada entrada i es una estación s_i y una ventana (la última semana: a=0, b=7; o la
semana anterior: a=7, b=14). Como cada horizonte tiene sus propios pesos, el método capta
que una crecida grande llega lenta y estirada por el valle de inundación: lo que subió
Corrientes en las últimas dos semanas sigue llegando a Santa Fe durante varios días más.
El método anterior (una estación de arriba con un retraso fijo) perdía esa cola y
mostraba el río estabilizándose antes de tiempo.

Las entradas se eligen de a una (selección hacia adelante) entre el propio puerto y los
puertos de hasta VENTANA posiciones aguas arriba, con validación cruzada por bloques de
tiempo: el error de cada bloque se mide con un modelo ajustado sin ese bloque. Ese error
fuera de muestra es la banda de la app (err), y err_sube es el mismo error medido solo en
días en que el puerto venía subiendo más de SUBE_7D m por semana.

Fuente: API pública del INA (alerta.ina.gob.ar).
Con VIGIA_CACHE=archivo.json se guardan/leen las series para recalibrar sin volver a bajarlas.
"""
import json, os, sys, time, urllib.request, urllib.parse, datetime as dt, math
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = "https://alerta.ina.gob.ar/a5/getObservaciones"
ANIOS = 3
H = 15             # horizonte en días
VENTANA = 8        # hasta cuántas posiciones aguas arriba se buscan entradas (Santa Fe llega a Corrientes)
MAX_ENTRADAS = 4
MEJORA_MIN = 0.005  # una entrada nueva tiene que bajar el error fuera de muestra al menos 0,5 %
LAMBDA = 1.0       # regularización (ridge) para que los pesos no se disparen
BLOQUES = 4        # bloques de tiempo de la validación cruzada
SUBE_7D = 0.15     # m en 7 días para considerar "río subiendo"
VENTANAS = [(0, 7), (7, 14)]   # última semana y semana anterior

def fetch(serie_id, start, end):
    q = urllib.parse.urlencode({"tipo": "puntual", "series_id": serie_id, "timestart": start, "timeend": end, "format": "csvless", "no_id": "true"})
    req = urllib.request.Request(BASE + "?" + q, headers={"User-Agent": "VigiaDelParana/1.0 (app comunitaria)"})
    with urllib.request.urlopen(req, timeout=120) as r:
        txt = r.read().decode("utf-8", "replace")
    out = {}
    for line in txt.splitlines():
        p = line.strip().split(",")
        if len(p) < 3 or not p[0][:4].isdigit():
            continue
        try:
            v = float(p[2])
        except ValueError:
            continue
        d = (dt.datetime.fromisoformat(p[0].replace("Z", "+00:00")) - dt.timedelta(hours=3)).date()
        out[d] = v
    return out

def daily(series, d0, d1):
    """Lista diaria continua entre d0 y d1; huecos cortos se interpolan, largos quedan None."""
    days = (d1 - d0).days + 1
    vals = [series.get(d0 + dt.timedelta(days=i)) for i in range(days)]
    i = 0
    while i < days:
        if vals[i] is None:
            j = i
            while j < days and vals[j] is None:
                j += 1
            if 0 < i and j < days and (j - i) <= 5:
                a, b = vals[i - 1], vals[j]
                for k in range(i, j):
                    vals[k] = a + (b - a) * (k - i + 1) / (j - i + 1)
            i = j
        else:
            i += 1
    return vals

def cargar_series(est):
    cache = os.environ.get("VIGIA_CACHE")
    hoy = dt.date.today()
    if cache and os.path.exists(cache):
        c = json.load(open(cache, encoding="utf-8"))
        print("series leídas de", cache, "hasta", c["d1"], file=sys.stderr)
        return {int(k): v for k, v in c["series"].items()}, c["d1"]
    d0, d1 = hoy - dt.timedelta(days=365 * ANIOS), hoy
    series = {}
    for e in est:
        try:
            series[e["id"]] = daily(fetch(e["serie_id"], d0.isoformat(), (d1 + dt.timedelta(days=1)).isoformat()), d0, d1)
            print("ok", e["nombre"], sum(v is not None for v in series[e["id"]]), "días", file=sys.stderr)
        except Exception as ex:
            print("fallo", e["nombre"], ex, file=sys.stderr)
        time.sleep(0.4)
    if cache:
        json.dump({"d0": d0.isoformat(), "d1": d1.isoformat(), "series": {str(k): v for k, v in series.items()}}, open(cache, "w", encoding="utf-8"))
    return series, d1.isoformat()

# ---------- modelo (numpy) ----------
def tabla(S, did, feats):
    """Índices t válidos, entradas X(t), cambios Y[:,k] = h(t+k+1) − h(t) (NaN si no hay dato) y marca de crecida."""
    hd = S[did]; n = len(hd); T = np.arange(14, n)
    X = np.stack([S[s][T - a] - S[s][T - b] for s, a, b in feats], 1) if feats else np.zeros((len(T), 0))
    Y = np.full((len(T), H), np.nan)
    for k in range(1, H + 1):
        m = T + k < n
        Y[m, k - 1] = hd[T[m] + k] - hd[T[m]]
    ok = ~np.isnan(X).any(1) & ~np.isnan(hd[T])
    sube = (hd[T] - hd[T - 7]) > SUBE_7D
    return T[ok], X[ok], Y[ok], sube[ok]

def ajustar(X, y):
    m = ~np.isnan(y)
    if m.sum() < 100:
        return None
    A = X[m]
    return np.linalg.solve(A.T @ A + LAMBDA * np.eye(A.shape[1]), A.T @ y[m])

def validar(T, X, Y, sube):
    """Errores fuera de muestra por bloques de tiempo (con un margen de H días entre ajuste y prueba)."""
    if len(T) < 200:
        return None
    edges = np.linspace(T[0], T[-1] + 1, BLOQUES + 1).astype(int)
    E = np.full(Y.shape, np.nan)
    for f in range(BLOQUES):
        lo, hi = edges[f], edges[f + 1]
        te = (T >= lo) & (T < hi); tr = (T < lo - H) | (T >= hi + H)
        for k in range(H):
            w = ajustar(X[tr], Y[tr, k])
            if w is None:
                return None
            E[te, k] = X[te] @ w - Y[te, k]
    def rm(M, minimo):
        out = []
        for k in range(H):
            e = M[:, k]; e = e[~np.isnan(e)]
            out.append(round(float(np.sqrt(np.mean(e * e))), 3) if len(e) >= minimo else None)
        return out
    return rm(E, 50), rm(E[sube], 20), int((~np.isnan(E[sube, 6])).sum())

def puntaje(err):
    v = [x for x in err[:10] if x is not None]
    return sum(v) / len(v) if len(v) >= 8 else None

def persistencia(hd):
    hd = [None if (v is None or v != v) else float(v) for v in hd]
    out = []
    for k in range(1, H + 1):
        e = [hd[t + k] - hd[t] for t in range(len(hd) - k) if hd[t] is not None and hd[t + k] is not None]
        out.append(round(math.sqrt(sum(x * x for x in e) / len(e)), 3) if e else None)
    return out

def main():
    est = json.load(open(os.path.join(ROOT, "data/estaciones.json"), encoding="utf-8"))["estaciones"]
    est = [e for e in est if not e.get("marea")]   # Delta inferior y Río de la Plata: manda la marea, no se modela
    byid = {e["id"]: e for e in est}
    series, hasta = cargar_series(est)
    S = {k: np.array([np.nan if v is None else v for v in vs], dtype=float) for k, vs in series.items()}
    modelo = {}
    for e in sorted(est, key=lambda x: x["orden"]):
        did = e["id"]
        if did not in series:
            continue
        cands = [u["id"] for u in est if u["id"] in series and u["orden"] <= e["orden"] and e["orden"] - u["orden"] <= VENTANA]
        pool = [(s, a, b) for s in cands for a, b in VENTANAS]
        elegidas, mejor, val = [], None, None
        while len(elegidas) < MAX_ENTRADAS:
            prueba = []
            for f in pool:
                if f in elegidas:
                    continue
                v = validar(*tabla(S, did, elegidas + [f]))
                sc = puntaje(v[0]) if v else None
                if sc is not None:
                    prueba.append((sc, f, v))
            if not prueba:
                break
            prueba.sort(key=lambda z: z[0])
            sc, f, v = prueba[0]
            if mejor is not None and sc > mejor * (1 - MEJORA_MIN):
                break
            elegidas.append(f); mejor, val = sc, v
        pers = persistencia(series[did])
        if val and sum(val[0][:7]) < sum(x for x in pers[:7] if x is not None):
            T, X, Y, _ = tabla(S, did, elegidas)
            W = [[round(float(w), 4) for w in ajustar(X, Y[:, k])] for k in range(H)]
            ent = [{"id": s, "nombre": byid[s]["nombre"], "desde": a, "hasta": b} for s, a, b in elegidas]
            modelo[str(did)] = {"entradas": ent, "w": W, "err": val[0], "err_sube": val[1], "n_sube": val[2], "n": int(len(T)), "persistencia": pers}
            desc = " + ".join(f'{x["nombre"]} ({"última semana" if x["desde"] == 0 else "semana anterior"})' for x in ent)
            print(f'{e["nombre"]:24s} <- {desc}  err3={val[0][2]} err7={val[0][6]} err15={val[0][14]} err7_sube={val[1][6]} (pers7 {pers[6]})', file=sys.stderr)
        else:
            modelo[str(did)] = {"persistencia": pers}
            print(f'{e["nombre"]:24s} sin modelo mejor que persistencia', file=sys.stderr)
    doc = {"ajustado": dt.date.today().isoformat(), "datos_hasta": hasta, "anios": ANIOS, "horizonte": H,
           "metodo": "directo", "sube_7d": SUBE_7D,
           "nota": "Proyección Vigía, método directo por horizonte: para cada puerto, el cambio de altura a k días (k=1..15) es la suma de w[k-1][i] por el cambio medido en cada entrada i: h_id(t-desde) - h_id(t-hasta), en días, siendo t el último dato del puerto. 'err' es el error RMSE fuera de muestra (validación cruzada por bloques de tiempo) y 'err_sube' el mismo error en días en que el puerto venía subiendo más de sube_7d m por semana. 'persistencia': error de suponer que el río no cambia, como referencia.",
           "estaciones": modelo}
    json.dump(doc, open(os.path.join(ROOT, "data/modelo.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("modelo.json escrito:", len(modelo), "estaciones", file=sys.stderr)

if __name__ == "__main__":
    main()
