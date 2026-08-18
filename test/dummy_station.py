"""Simulador de telemetria para las estaciones MedStation.

Ejemplos:
    python test/dummy_station.py spiro
    python test/dummy_station.py body --token TOKEN_DE_THINGSBOARD
    python test/dummy_station.py stress --server http://192.168.2.119:8080
"""

import argparse
import json
import os
import random
import time
import urllib.error
import urllib.request


STATIONS = {
    "spiro": {
        "token_env": "TB_TOKEN_SPIRO",
        "default_token": None,
        "minimum": 3.5,
        "maximum": 4.1,
        "decimals": 2,
        "unit": "L",
    },
    "body": {
        "token_env": "TB_TOKEN_BODY",
        "default_token": None,
        "minimum": 18.0,
        "maximum": 28.0,
        "decimals": 1,
        "unit": "% grasa",
    },
    "stress": {
        "token_env": "TB_TOKEN_STRESS",
        "default_token": None,
        "minimum": 30.0,
        "maximum": 75.0,
        "decimals": 0,
        "unit": "% HRV",
    },
}


def parse_args():
    parser = argparse.ArgumentParser(description="Envia telemetria dummy a ThingsBoard")
    parser.add_argument("station", choices=STATIONS, help="Estacion que se desea simular")
    parser.add_argument(
        "--server",
        default=os.getenv("TB_SERVER", "http://localhost:8080"),
        help="URL de ThingsBoard (por defecto: http://localhost:8080)",
    )
    parser.add_argument("--token", help="Token de acceso del dispositivo")
    parser.add_argument("--interval", type=float, default=6.0, help="Segundos entre lecturas")
    parser.add_argument("--count", type=int, default=0, help="Cantidad de lecturas; 0 significa infinito")
    return parser.parse_args()


def send_reading(url, value):
    payload = json.dumps({"value": value}).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return response.status


def main():
    args = parse_args()
    station = STATIONS[args.station]
    token = args.token or os.getenv(station["token_env"]) or station["default_token"]
    if not token:
        raise SystemExit(
            f"Falta el token. Use --token TOKEN o defina {station['token_env']}."
        )

    url = f"{args.server.rstrip('/')}/api/v1/{token}/telemetry"
    sent = 0
    print(f"Simulando {args.station} hacia {args.server}. Detener con Ctrl+C.")

    try:
        while args.count == 0 or sent < args.count:
            value = round(
                random.uniform(station["minimum"], station["maximum"]),
                station["decimals"],
            )
            try:
                status = send_reading(url, value)
                sent += 1
                print(f"[{sent}] {value} {station['unit']} -> HTTP {status}")
            except urllib.error.HTTPError as error:
                print(f"Error HTTP {error.code}: {error.reason}")
            except urllib.error.URLError as error:
                print(f"No se pudo conectar: {error.reason}")

            if args.count == 0 or sent < args.count:
                time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\nSimulador detenido.")


if __name__ == "__main__":
    main()
