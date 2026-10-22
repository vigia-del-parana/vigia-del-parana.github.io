#!/usr/bin/env python3
"""Calibra el modelo de propagación de Vigía del Paraná y escribe data/modelo.json.

Idea: la altura de un puerto responde, con algunos días de retraso, a lo que pasó en uno o
dos puertos de aguas arriba. Para cada estación se busca la combinación de estaciones de
aguas arriba y retrasos (lag) que mejor explica sus variaciones en los últimos años, y se
mide el error real de la proyección a 1..15 días con pruebas sobre el pasado (backtest).

Dos entradas sirven en las confluencias: Corrientes depende del Alto Paraná (Itatí, Paso de
la Patria) y también del río Paraguay (Formosa). Con una sola entrada, una crecida que viene
por el Paraguay queda invisible para toda la cadena de aguas abajo.

Regla de proyección (la misma que usa la app):
  h_d(t+k) ≈ h_d(t) + Σ_i b_i · [ h_ui(t+k−L_i) − h_ui(t−L_i) ]
  si t+k−L_i ya pasó, h_ui es dato medido; si no, se usa la proyección en cadena de ui
  (o su pendiente reciente amortiguada si ui no tiene modelo).

Además del error general (err), se mide el error en días de crecida (err_sube: cuando el
puerto subió más de SUBE_7D en la última semana), que es mayor y es el que la app muestra
cuando el río viene subiendo.

Fuente de datos: API pública del INA (alerta.ina.gob.ar).
Con VIGIA_CACHE=archivo.json se guardan/leen las series para recalibrar sin volver a bajarlas.
"""
import json, os, sys, time, urllib.request, urllib.parse, datetime as dt, math

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = "https://alerta.ina.gob.ar/a5/getObservaciones"
ANIOS = 3
H = 15            # horizonte en días
MAXLAG = 10
DECAY = 0.85      # amortiguación de la pendiente al prolongar aguas arriba
VENTANA = 5       # cuántos puertos (por orden) hacia arriba se prueban como entrada
MEJORA_PAR = 0.03 # un par de entradas tiene que bajar el error al menos 3 % para elegirse
SUBE_7D = 0.15    # m en 7 días para considerar "río subiendo"

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

CHAIN = {}      # id -> [{"up","lag","b"}, ...]
SERIES = {}     # id -> lista diaria
MEMO = {}

def upstream_value(uid, t, k):
    """Valor (medido o proyectado en cadena) de la estación uid en t+k, usando datos hasta t."""
    hu = SERIES[uid]
    if k <= 0:
        return hu[t + k] if t + k >= 0 else None
    key = (uid, t, k)
    if key in MEMO:
        return MEMO[key]
    val = None
    ins = CHAIN.get(uid)
    if ins:
        val = project(uid, ins, t, k)
    if val is None:
        if hu[t] is not None and t - 5 >= 0 and hu[t - 5] is not None:
            slope = (hu[t] - hu[t - 5]) / 5.0
            ext, sl = hu[t], slope
            for _ in range(k):
                sl *= DECAY; ext += sl
            val = ext
    MEMO[key] = val
    return val

def project(did, ins, t, k):
    """Proyección de did a k días desde el índice t usando solo datos hasta t (en cadena)."""
    base = SERIES[did][t]
    if base is None:
        return None
    tot = base
    for m in ins:
        hu, L = SERIES[m["up"]], m["lag"]
        src = t - L
        if src < 0 or hu[src] is None:
            return None
        v = upstream_value(m["up"], t, k - L)
        if v is None:
            return None
        tot += m["b"] * (v - hu[src])
    return tot

def pares(hd, hus_lags):
    """Variaciones semanales alineadas: y = Δ7 h_d(t), x_i = Δ7 h_ui(t−L_i)."""
    ys, xs = [], []
    Lmax = max(L for _, L in hus_lags)
    for t in range(Lmax + 7, len(hd)):
        if hd[t] is None or hd[t - 7] is None:
            continue
        row = []
        for hu, L in hus_lags:
            a, b = hu[t - L], hu[t - L - 7]
            if a is None or b is None:
                row = None; break
            row.append(a - b)
        if row is None:
            continue
        ys.append(hd[t] - hd[t - 7]); xs.append(row)
    return ys, xs

def fit1(hd, hu, L):
    ys, xs = pares(hd, [(hu, L)])
    if len(ys) < 100:
        return None
    sxx = sum(x[0] * x[0] for x in xs); sxy = sum(x[0] * y for x, y in zip(xs, ys))
    if sxx == 0:
        return None
    b = sxy / sxx
    sy = sum(y * y for y in ys)
    sse = sum((y - b * x[0]) ** 2 for x, y in zip(xs, ys))
    return [b], (1 - sse / sy) if sy else 0, len(ys), sse

def fit2(hd, hu1, L1, hu2, L2):
    ys, xs = pares(hd, [(hu1, L1), (hu2, L2)])
    if len(ys) < 100:
        return None
    a11 = sum(x[0] * x[0] for x in xs); a22 = sum(x[1] * x[1] for x in xs); a12 = sum(x[0] * x[1] for x in xs)
    c1 = sum(x[0] * y for x, y in zip(xs, ys)); c2 = sum(x[1] * y for x, y in zip(xs, ys))
    det = a11 * a22 - a12 * a12
    if abs(det) < 1e-9:
        return None
    b1 = (c1 * a22 - c2 * a12) / det; b2 = (a11 * c2 - a12 * c1) / det
    sy = sum(y * y for y in ys)
    sse = sum((y - b1 * x[0] - b2 * x[1]) ** 2 for x, y in zip(xs, ys))
    return [b1, b2], (1 - sse / sy) if sy else 0, len(ys), sse

def backtest(did, ins):
    hd = SERIES[did]
    Lmax = max(m["lag"] for m in ins)
    errs = [[] for _ in range(H + 1)]
    errs_sube = [[] for _ in range(H + 1)]
    for t in range(Lmax + 7, len(hd) - H):
        sube = hd[t] is not None and hd[t - 7] is not None and hd[t] - hd[t - 7] > SUBE_7D
        for k in range(1, H + 1):
            p = project(did, ins, t, k)
            if p is None or hd[t + k] is None:
                continue
            errs[k].append(p - hd[t + k])
            if sube:
                errs_sube[k].append(p - hd[t + k])
    def rmse(lst, minimo):
        out = []
        for k in range(1, H + 1):
            e = lst[k]
            out.append(round(math.sqrt(sum(x * x for x in e) / len(e)), 3) if len(e) >= minimo else None)
        return out
    return rmse(errs, 50), rmse(errs_sube, 20), len(errs_sube[7])

def persistence_error(hd):
    out = []
    for k in range(1, H + 1):
        e = [hd[t + k] - hd[t] for t in range(len(hd) - H) if hd[t] is not None and hd[t + k] is not None]
        out.append(round(math.sqrt(sum(x * x for x in e) / len(e)), 3) if e else None)
    return out

def score_of(err):
    vals = [x for x in err[:10] if x is not None]
    return sum(vals) / len(vals) if len(vals) >= 8 else None

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

def main():
    est = json.load(open(os.path.join(ROOT, "data/estaciones.json"), encoding="utf-8"))["estaciones"]
    est = [e for e in est if not e.get("marea")]   # Delta inferior y Río de la Plata: manda la marea, no se modela
    byid = {e["id"]: e for e in est}
    series, hasta = cargar_series(est)
    global SERIES
    SERIES = series
    modelo = {}
    for e in sorted(est, key=lambda x: x["orden"]):      # aguas arriba primero: la cadena ya está lista
        did = e["id"]
        hd = series.get(did)
        if not hd:
            continue
        cands = [u for u in est if u["id"] in series and u["orden"] < e["orden"] and (e["orden"] - u["orden"]) <= VENTANA]
        # 1) una entrada: se ajusta y se prueba cada (estación, lag)
        best1 = None
        for u in cands:
            for L in range(1, MAXLAG + 1):
                f = fit1(hd, series[u["id"]], L)
                if not f or f[0][0] <= 0:
                    continue
                ins = [{"up": u["id"], "lag": L, "b": f[0][0]}]
                err, err_s, n_s = backtest(did, ins)
                sc = score_of(err)
                if sc is not None and (best1 is None or sc < best1["score"]):
                    best1 = {"ins": ins, "r2": f[1], "n": f[2], "err": err, "err_sube": err_s, "n_sube": n_s, "score": sc}
        # 2) dos entradas: se ajustan todas las combinaciones y se prueban las 6 de menor error de ajuste
        fits2 = []
        for i, u1 in enumerate(cands):
            for u2 in cands[i + 1:]:
                for L1 in range(1, MAXLAG + 1):
                    for L2 in range(1, MAXLAG + 1):
                        f = fit2(hd, series[u1["id"]], L1, series[u2["id"]], L2)
                        if not f or min(f[0]) <= 0.02:
                            continue
                        fits2.append((f[3] / f[2], u1, L1, u2, L2, f))
        fits2.sort(key=lambda x: x[0])
        best2 = None
        for _, u1, L1, u2, L2, f in fits2[:6]:
            ins = [{"up": u1["id"], "lag": L1, "b": f[0][0]}, {"up": u2["id"], "lag": L2, "b": f[0][1]}]
            err, err_s, n_s = backtest(did, ins)
            sc = score_of(err)
            if sc is not None and (best2 is None or sc < best2["score"]):
                best2 = {"ins": ins, "r2": f[1], "n": f[2], "err": err, "err_sube": err_s, "n_sube": n_s, "score": sc}
        best = best1
        if best2 and (best1 is None or best2["score"] < best1["score"] * (1 - MEJORA_PAR)):
            best = best2
        pers = persistence_error(hd)
        if best and sum(best["err"][:7]) < sum(x for x in pers[:7] if x is not None):
            ins = sorted(best["ins"], key=lambda m: -m["b"])     # la de mayor peso primero
            for m in ins:
                m["b"] = round(m["b"], 3); m["up_nombre"] = byid[m["up"]]["nombre"]
            CHAIN[did] = [{"up": m["up"], "lag": m["lag"], "b": m["b"]} for m in ins]
            p = ins[0]
            modelo[str(did)] = {"up": p["up"], "up_nombre": p["up_nombre"], "lag": p["lag"], "b": p["b"],
                                "entradas": ins, "r2": round(best["r2"], 3), "n": best["n"],
                                "err": best["err"], "err_sube": best["err_sube"], "n_sube": best["n_sube"], "persistencia": pers}
            desc = " + ".join(f'{m["up_nombre"]} ({m["lag"]}d, b={m["b"]:.2f})' for m in ins)
            s1 = f'{best1["score"]:.3f}' if best1 else "-"
            s2 = f'{best2["score"]:.3f}' if best2 else "-"
            print(f'{e["nombre"]:24s} <- {desc}  r2={best["r2"]:.2f} err3={best["err"][2]} err7={best["err"][6]} err7_sube={best["err_sube"][6]} (n={best["n_sube"]})  [1 entrada {s1} · 2 entradas {s2}]', file=sys.stderr)
        else:
            modelo[str(did)] = {"persistencia": pers}
            print(f'{e["nombre"]:24s} sin modelo mejor que persistencia', file=sys.stderr)
        MEMO.clear()
    doc = {"ajustado": dt.date.today().isoformat(), "datos_hasta": hasta, "anios": ANIOS, "horizonte": H, "decay": DECAY,
           "cadena": True, "sube_7d": SUBE_7D,
           "nota": "Modelo de propagación en cadena por estación. 'entradas': una o dos estaciones de aguas arriba con su retraso en días (lag) y ganancia (b); up/lag/b repiten la principal. 'err': error RMSE del backtest a 1..15 días; 'err_sube': el mismo error medido solo en días en que el puerto venía subiendo más de sube_7d m por semana. 'persistencia': error de suponer que el río no cambia, como referencia.",
           "estaciones": modelo}
    json.dump(doc, open(os.path.join(ROOT, "data/modelo.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("modelo.json escrito:", len(modelo), "estaciones", file=sys.stderr)

if __name__ == "__main__":
    main()
