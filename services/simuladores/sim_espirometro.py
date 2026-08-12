import time
import json
import random
from paho.mqtt import client as mqtt_client

# --- Credenciales MQTT Basic del dispositivo "Espirometro" ---
CLIENT_ID = "morzbgbr1lsspaok8a51"
USERNAME = "hak273zxwn3fx0v0646p"
PASSWORD = "ojm8azsew17ef99bq1ab"

BROKER = "localhost"
PORT = 1883
TOPIC = "v1/devices/me/telemetry"

def on_connect(client, userdata, flags, rc, properties=None):
    if rc == 0:
        print("Conectado a ThingsBoard MQTT broker")
    else:
        print(f"Fallo al conectar, código: {rc}")

def connect_mqtt():
    client = mqtt_client.Client(
        client_id=CLIENT_ID,
        callback_api_version=mqtt_client.CallbackAPIVersion.VERSION2
    )
    client.username_pw_set(USERNAME, PASSWORD)
    client.on_connect = on_connect
    client.connect(BROKER, PORT)
    return client

def publish_loop(client):
    valor_base = 3.8
    while True:
        valor = round(valor_base + random.uniform(-0.3, 0.3), 2)
        payload = json.dumps({"value": valor})
        result = client.publish(TOPIC, payload)
        status = result[0]
        if status == 0:
            print(f"Enviado: {payload}")
        else:
            print(f"Error al enviar mensaje")
        time.sleep(5)

if __name__ == "__main__":
    client = connect_mqtt()
    client.loop_start()
    try:
        publish_loop(client)
    except KeyboardInterrupt:
        print("Detenido por el usuario")
        client.loop_stop()
