# MedStation Web


tenant@thingsboard.org
http://localhost:3000/



Sistema académico para recibir telemetría de estaciones médicas, asociar mediciones automáticamente con un paciente activo y permitir que cada paciente consulte su historial.

## Arquitectura

```text
ESP32 / simuladores
        │ HTTP hacia ThingsBoard (puerto 8080)
        ▼
ThingsBoard ──► PostgreSQL
        │
        ▼
API y página MedStation (puerto 3000)
        │
        ├── Administrador selecciona el paciente activo
        └── Paciente consulta su propio historial
```

La computadora principal funciona como servidor. Debe permanecer encendida y conectada a la misma red Wi-Fi que las estaciones y los demás usuarios.

## Requisitos instalados

- Windows con WSL 2.
- Docker Desktop.
- Node.js y npm.
- Vercel CLI.
- Python 3 para ejecutar los simuladores.

Comandos para comprobarlos:

```powershell
wsl --status
docker --version
docker compose version
node --version
npm --version
vercel --version
python --version
```

## Arranque después de apagar o reiniciar la computadora

### 1. Abrir Docker Desktop

Abra **Docker Desktop** desde el menú Inicio y espere hasta que indique **Engine running**.

Compruebe el motor desde PowerShell:

```powershell
docker info
```

La salida debe contener información de `Client` y `Server` sin errores.

### 2. Iniciar PostgreSQL y ThingsBoard

Abra una PowerShell y ejecute:

```powershell
cd "C:\Users\User\OneDrive - Estudiantes ITCR\Documentos\Semestre 9\INTEGRADOR\medical-station-web\infra\docker"
docker compose up -d
docker compose ps
```

Deben aparecer activos:

```text
gecb-postgres
gecb-thingsboard
```

La primera carga de ThingsBoard puede tardar de dos a cinco minutos. Compruebe:

```text
http://localhost:8080
```

Para observar el arranque:

```powershell
docker logs -f gecb-thingsboard
```

Use `Ctrl + C` para dejar de seguir los registros. Esto no detiene el contenedor.

### 3. Iniciar MedStation

Abra una segunda PowerShell y ejecute:

```powershell
cd "C:\Users\User\OneDrive - Estudiantes ITCR\Documentos\Semestre 9\INTEGRADOR\medical-station-web"
vercel dev --listen 0.0.0.0:3000
```

Mantenga esa terminal abierta. En la computadora servidor, abra:

```text
http://localhost:3000
```

## Acceso desde otros dispositivos de la misma red

Obtenga la IPv4 actual del servidor:

```powershell
ipconfig
```

Busque la dirección IPv4 del adaptador Wi-Fi activo. Un ejemplo es:

```text
192.168.2.119
```

Desde otro teléfono o computadora en la misma red:

```text
MedStation:  http://IP-DEL-SERVIDOR:3000
ThingsBoard: http://IP-DEL-SERVIDOR:8080
```

Ejemplo:

```text
http://192.168.2.119:3000
http://192.168.2.119:8080
```

La IP puede cambiar al conectarse a otra red o reiniciar el router. Se recomienda reservar una IP fija para el servidor en el router.

Si otro dispositivo no puede conectarse, ejecute PowerShell como administrador:

```powershell
New-NetFirewallRule -DisplayName "MedStation Web" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private
New-NetFirewallRule -DisplayName "ThingsBoard" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow -Profile Private
```

Configure también la red de Windows como **Privada**.

## Inicio de sesión

### Administrador / técnico

Seleccione `Administrador / técnico` en la página e ingrese una cuenta de ThingsBoard.

Cuenta local inicial usada durante el desarrollo:

```text
Correo: tenant@thingsboard.org
Contraseña: tenant
```

### Paciente

Seleccione `Paciente` e ingrese el usuario o correo y la contraseña de la cuenta.

### Crear cuenta de paciente

Seleccione `Crear cuenta de paciente`. El usuario ingresa:

- Nombre de usuario.
- Correo.
- Contraseña de mínimo ocho caracteres.

El sistema genera automáticamente un número como `PAC-XXXXXXXX`. Después, el paciente completa:

- Nombre.
- Apellido.
- Edad.
- Sexo F o M.
- Altura en centímetros.
- Peso en kilogramos.

## Flujo de una medición

1. El administrador inicia sesión.
2. Selecciona una persona en **Paciente activo**.
3. Confirma el mensaje que indica el código activo.
4. La estación envía una lectura nueva a ThingsBoard.
5. MedStation consulta ThingsBoard cada cinco segundos.
6. La lectura nueva se guarda automáticamente en `medstation` para el paciente activo.
7. Al finalizar, el administrador selecciona **Ningún paciente activo**.

Si no hay paciente activo, ThingsBoard conserva la telemetría, pero la lectura no se agrega a ningún expediente clínico.

La misma lectura no se guarda dos veces. Los valores iguales o menores que cero tampoco se consideran resultados clínicos válidos.

## Ejecutar estaciones de prueba

El simulador está en `test/dummy_station.py` y no requiere paquetes externos.

Desde la raíz del proyecto:

```powershell
cd "C:\Users\User\OneDrive - Estudiantes ITCR\Documentos\Semestre 9\INTEGRADOR\medical-station-web"
```

Espirómetro:

```powershell
python test\dummy_station.py spiro --token TOKEN_DEL_ESPIROMETRO
```

Composición corporal:

```powershell
python test\dummy_station.py body --token TOKEN_DE_COMPOSICION
```

Analizador de estrés:

```powershell
python test\dummy_station.py stress --token TOKEN_DE_ESTRES
```

Enviar cinco lecturas y terminar:

```powershell
python test\dummy_station.py spiro --token TOKEN_DEL_ESPIROMETRO --count 5
```

Desde otra computadora, indique la IP del servidor:

```powershell
python test\dummy_station.py spiro --token TOKEN_DEL_ESPIROMETRO --server http://IP-DEL-SERVIDOR:8080
```

También puede definir `TB_TOKEN_SPIRO`, `TB_TOKEN_BODY` y `TB_TOKEN_STRESS` como variables de entorno. Los tokens no se incluyen en Git.

Detenga un simulador continuo con `Ctrl + C`.

## Configuración de las ESP32

Cada estación debe conectarse al Wi-Fi y enviar JSON a:

```text
POST http://IP-DEL-SERVIDOR:8080/api/v1/TOKEN-DE-LA-ESTACION/telemetry
Content-Type: application/json

{"value": 3.85}
```

Cada ESP32 debe usar exclusivamente el token de su dispositivo. El token identifica qué estación envió la medición.

Dispositivos configurados:

| Estación | UUID de ThingsBoard |
|---|---|
| Espirómetro | `25b60360-96d2-11f1-8613-25d51c94920b` |
| Composición corporal | `0421ca00-96e0-11f1-8613-25d51c94920b` |
| Analizador de estrés | `33ced630-96e0-11f1-8613-25d51c94920b` |

Los UUID sirven para consultar telemetría. Los tokens sirven para publicarla y deben mantenerse privados.

## Variables locales

El archivo `.env.local` contiene:

```env
TB_BASE_URL=http://localhost:8080
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/medstation
SESSION_SECRET=un-secreto-local
```

Este archivo está ignorado por Git y no debe publicarse. En un despliegue real, cambie `SESSION_SECRET` por un valor largo y aleatorio.

## Persistencia de la base de datos

Los pacientes y las mediciones no se guardan en Git. Se almacenan en el volumen Docker de PostgreSQL y permanecen después de apagar o reiniciar la computadora.

Puede detener los servicios sin borrar datos:

```powershell
docker compose down
```

No use este comando si desea conservar la base:

```powershell
docker compose down -v
```

La opción `-v` elimina el volumen y puede borrar pacientes y mediciones.

## Ver la base de datos

Entre a PostgreSQL:

```powershell
docker exec -it gecb-postgres psql -U postgres -d medstation
```

Liste las tablas:

```sql
\dt
```

Consulte las mediciones:

```sql
SELECT * FROM measurements ORDER BY measured_at DESC;
```

Salga con:

```sql
\q
```

No modifique las tablas internas de la base `thingsboard` manualmente.

## Respaldo de MedStation

Desde PowerShell:

```powershell
docker exec gecb-postgres pg_dump -U postgres -d medstation > medstation_backup.sql
```

El respaldo puede contener información personal y médica. No debe subirse a un repositorio público.

## Detener el sistema

1. Detenga `vercel dev` con `Ctrl + C`.
2. Detenga los simuladores con `Ctrl + C`.
3. Desde `infra/docker`, ejecute:

```powershell
docker compose down
```

4. Cierre Docker Desktop si lo desea.

## Solución rápida de problemas

### Docker no responde

```powershell
wsl --shutdown
```

Abra Docker Desktop nuevamente y compruebe:

```powershell
docker info
```

### ThingsBoard no abre

```powershell
docker compose ps
docker logs --tail 100 gecb-thingsboard
```

### La página no abre

Compruebe que `vercel dev --listen 0.0.0.0:3000` siga ejecutándose.

### Una estación recibe HTTP 401

El token utilizado no pertenece al dispositivo. Copie el **Access token** desde ThingsBoard, no el UUID.

### Una medición no aparece en un paciente

- Confirme que hay un paciente activo.
- Envíe una lectura nueva después de seleccionarlo.
- Espere al menos cinco segundos.
- Confirme que el valor sea mayor que cero.
- Compruebe que el dashboard administrativo esté abierto y actualizándose.

### Cambió la red Wi-Fi

Ejecute `ipconfig`, obtenga la nueva IPv4 y actualice la dirección utilizada por teléfonos, computadoras y ESP32.

## Orden mínimo de arranque

```text
1. Abrir Docker Desktop
2. docker compose up -d
3. Esperar a ThingsBoard en localhost:8080
4. vercel dev --listen 0.0.0.0:3000
5. Abrir localhost:3000
6. Seleccionar paciente activo
7. Encender ESP32 o ejecutar simuladores
```
