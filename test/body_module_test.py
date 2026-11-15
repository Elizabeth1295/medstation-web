"""Prueba de conexion del modulo de body (simula lo que hara la ESP32).

Hace las DOS direcciones usando solo HTTP y la libreria estandar
(no requiere paho-mqtt ni nada externo):

  1) Pagina -> Modulo: lee los datos del paciente activo (height, age, sex)
     que el server empuja a ThingsBoard como "shared attributes".
  2) Modulo -> Pagina: envia una medicion COMPLETA con todas las metricas
     (peso, grasa, FFM, agua, musculo, hueso, IMC, metabolismo, R, X, fase).

Uso:
    python test/body_module_test.py --token TOKEN_DEL_BODY            (solo lee paciente)
    python test/body_module_test.py --token TOKEN_DEL_BODY --send     (lee + envia una medicion)
    python test/body_module_test.py --token TOKEN_DEL_BODY --loop     (envia cada 6 s)
    python test/body_module_test.py --token TOKEN_DEL_BODY --watch    (escucha cambios de paciente)
    python test/body_module_test.py --token TOKEN_DEL_BODY --server http://IP-DEL-SERVIDOR:8080
"""

import argparse
import json
import random
import time
import urllib.error
import urllib.request


# Nombres de clave REALES que envia el modulo de body (los mismos que lee
# api/telemetry.js). Coinciden con lo que manda el firmware de la ESP32.
def build_body_payload():
    peso = round(random.uniform(55, 90), 1)
    gp = round(random.uniform(18, 30), 2)        # grasa %  (metrica principal)
    gk = round(peso * gp / 100, 2)               # grasa kg
    ffm = round(peso - gk, 2)                    # masa libre de grasa (kg)
    tbw = round(ffm * 0.73, 2)                   # agua total (L)
    return {
        "value": gp,                             # metrica principal = grasa %
        "peso": peso,                            # kg
        "gp": gp,                                # grasa %
        "gk": gk,                                # grasa kg
        "ffm": ffm,                              # masa libre de grasa kg
        "tbw": tbw,                              # agua total (L)
        "tp": round(random.uniform(38, 55), 2),  # % agua
        "mus": round(ffm * 0.93, 2),             # musculo kg
        "mme": round(ffm * 0.45, 2),             # masa muscular esqueletica kg
        "hue": round(random.uniform(2.2, 3.5), 2),   # hueso kg
        "pro": round(random.uniform(7, 12), 2),      # proteina kg
        "imc": round(random.uniform(20, 28), 1),     # indice de masa corporal
        "bmr": round(random.uniform(1300, 1800)),    # metabolismo basal kcal
        "R": round(random.uniform(450, 900), 2),     # resistencia (ohm)
        "X": round(random.uniform(25, 70), 2),       # reactancia (ohm)
        "F": round(random.uniform(1.5, 7), 3),       # angulo de fase (grados)
        "persona_ok": 1,                         # control
        "id": 1,                                 # control
    }


def http_get(url):
    with urllib.request.urlopen(url, timeout=35) as response:
        return response.status, response.read().decode("utf-8")


def http_post(url, data):
    payload = json.dumps(data).encode("utf-8")
    request = urllib.request.Request(
        url, data=payload,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return response.status


def read_patient(base, token):
    """Lee los shared attributes del paciente activo (como hara el firmware al arrancar)."""
    url = f"{base}/api/v1/{token}/attributes?sharedKeys=height,age,sex"
    status, body = http_get(url)
    data = json.loads(body) if body else {}
    shared = data.get("shared", {})
    if shared:
        print(f"[Paciente] HTTP {status}  "
              f"height={shared.get('height')} cm, "
              f"age={shared.get('age')}, "
              f"sex={shared.get('sex')}")
    else:
        print(f"[Paciente] HTTP {status}  (vacio) "
              "No hay paciente activo en el body, o faltan sus datos.")
    return shared


def send_measurement(base, token):
    payload = build_body_payload()
    status = http_post(f"{base}/api/v1/{token}/telemetry", payload)
    print(f"[Medicion] HTTP {status}  " + ", ".join(f"{k}={v}" for k, v in payload.items()))


def watch_updates(base, token):
    """Escucha cambios de atributos (long-poll), como hara la ESP32 en vivo."""
    print("[Watch] Esperando cambios de paciente... (Ctrl+C para salir)")
    url = f"{base}/api/v1/{token}/attributes/updates?timeout=30000"
    while True:
        try:
            status, body = http_get(url)
            if body and body.strip() not in ("", "{}"):
                print(f"[Cambio] {body}")
        except urllib.error.URLError as error:
            print(f"[Watch] Sin respuesta: {error.reason}")
        except KeyboardInterrupt:
            print("\n[Watch] Detenido.")
            return


def main():
    parser = argparse.ArgumentParser(description="Prueba de conexion del modulo de body")
    parser.add_argument("--token", required=True, help="Access token del dispositivo body")
    parser.add_argument("--server", default="http://localhost:8080", help="URL de ThingsBoard")
    parser.add_argument("--send", action="store_true", help="Envia una medicion completa")
    parser.add_argument("--loop", action="store_true", help="Envia una medicion cada --interval seg")
    parser.add_argument("--interval", type=float, default=6.0, help="Segundos entre mediciones en --loop")
    parser.add_argument("--watch", action="store_true", help="Queda escuchando cambios de paciente en vivo")
    args = parser.parse_args()
    base = args.server.rstrip("/")

    try:
        read_patient(base, args.token)

        if args.loop:
            print("Enviando mediciones completas. Detener con Ctrl+C.")
            try:
                while True:
                    send_measurement(base, args.token)
                    time.sleep(args.interval)
            except KeyboardInterrupt:
                print("\nSimulador detenido.")
        elif args.send:
            send_measurement(base, args.token)

        if args.watch:
            watch_updates(base, args.token)
    except urllib.error.HTTPError as error:
        raise SystemExit(f"Error HTTP {error.code}: {error.reason} "
                         "(revisa el token y que ThingsBoard este arriba)")
    except urllib.error.URLError as error:
        raise SystemExit(f"No se pudo conectar: {error.reason}")


if __name__ == "__main__":
    main()
