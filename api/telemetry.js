// ================================================================
import { query } from './_db.js';
// Proxy serverless: reenvía el token de sesión del usuario logueado
// (obtenido en /api/auth) hacia ThingsBoard. Ya NO se loguea con una
// cuenta fija: así ThingsBoard aplica sus propios permisos por
// Customer y bloquea automáticamente el acceso a módulos ajenos.
// ================================================================

const TB_BASE_URL = process.env.TB_BASE_URL || 'http://localhost:8080';

const DEVICE_IDS = {
    spiro: '25b60360-96d2-11f1-8613-25d51c94920b',
    body: '0421ca00-96e0-11f1-8613-25d51c94920b',
    stress: '33ced630-96e0-11f1-8613-25d51c94920b'
};

const TELEMETRY_KEY = 'value';
const STATION_CODES = { spiro: 'SPIRO-01', body: 'BODY-01', stress: 'STRESS-01' };
const UNITS = { spiro: 'L', body: '% grasa', stress: '% HRV' };
// Metrica "principal" que se muestra en el tablero y en la columna Valor.
// El modulo de body envia la grasa en 'value'; el de espiro NO envia 'value',
// su medicion principal es la FVC (fvc_L).
const PRIMARY_KEY = { spiro: 'fvc_L', body: 'value', stress: 'value' };

// Claves de control que el modulo manda pero NO son mediciones clinicas.
const IGNORED_KEYS = new Set(['id', 'persona_ok']);

// Convierte la respuesta de ThingsBoard ({ value:[{ts,value}], peso:[...], ... })
// en un punto con: metrica principal (value), timestamp y TODAS las metricas.
// Solo toma las claves de la MISMA medicion (mismo ts) para no mezclar datos
// viejos de otras pruebas que queden guardados en ThingsBoard.
function buildPoint(device, json) {
    const keys = Object.keys(json || {});
    if (!keys.length) return null;

    let maxTs = null;
    for (const key of keys) {
        const latest = (json[key] || [])[0];
        if (!latest) continue;
        const t = Number(latest.ts);
        if (Number.isFinite(t) && (maxTs === null || t > maxTs)) maxTs = t;
    }
    if (maxTs === null) return null;

    const metrics = {};
    for (const key of keys) {
        if (IGNORED_KEYS.has(key)) continue;
        const latest = (json[key] || [])[0];
        if (!latest) continue;
        const t = Number(latest.ts);
        if (!Number.isFinite(t) || (maxTs - t) > 5000) continue; // solo la medicion mas reciente
        const num = Number(latest.value);
        metrics[key] = Number.isFinite(num) ? num : latest.value;
    }

    const primaryKey = PRIMARY_KEY[device] || TELEMETRY_KEY;
    let value = Number(metrics[primaryKey]);
    if (!Number.isFinite(value)) value = Number(metrics[TELEMETRY_KEY]);
    return { value, ts: maxTs, metrics };
}

async function saveForActivePatient(device, point) {
    const value = Number(point?.value);
    if (!point || !Number.isFinite(value) || value <= 0 || !Number.isFinite(Number(point.ts))) return;
    await query(`
        INSERT INTO measurements (patient_id, station_id, value, unit, measured_at, source_ts, metrics)
        SELECT a.patient_id, s.id, $2, $3, TO_TIMESTAMP($4 / 1000.0), $4, $5::jsonb
        FROM stations s
        JOIN station_active_patient a ON a.station_id = s.id
        WHERE s.station_code = $1 AND a.patient_id IS NOT NULL
        ON CONFLICT (station_id, source_ts) WHERE source_ts IS NOT NULL DO NOTHING
    `, [STATION_CODES[device], value, UNITS[device], Number(point.ts), JSON.stringify(point.metrics || {})]);
}

async function tbFetch(path, token) {
    const res = await fetch(`${TB_BASE_URL}${path}`, {
        headers: { 'X-Authorization': `Bearer ${token}` }
    });
    if (!res.ok) {
        const err = new Error(`Error ThingsBoard: ${res.status}`);
        err.status = res.status;
        throw err;
    }
    return res.json();
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');

    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!token) {
        res.status(401).json({ error: 'Falta token de sesión' });
        return;
    }

    const { device, type } = req.query;
    const deviceId = DEVICE_IDS[device];

    if (!deviceId) {
        res.status(400).json({ error: 'Parámetro "device" inválido. Use: spiro, body, stress.' });
        return;
    }

    try {
        const primaryKey = PRIMARY_KEY[device] || TELEMETRY_KEY;

        if (type === 'history') {
            const limit = req.query.limit || 10;
            const endTs = Date.now();
            const startTs = endTs - 60 * 60 * 1000;
            const path = `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries` +
                `?keys=${primaryKey}&startTs=${startTs}&endTs=${endTs}&limit=${limit}&orderBy=DESC`;
            const json = await tbFetch(path, token);
            res.status(200).json(json[primaryKey] || []);
        } else {
            // Trae TODAS las claves de telemetria del dispositivo (sin filtrar por keys).
            const path = `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries`;
            const json = await tbFetch(path, token);
            await saveForActivePatient(device, buildPoint(device, json));
            // El tablero solo necesita la metrica principal.
            res.status(200).json(json[primaryKey] || json[TELEMETRY_KEY] || []);
        }
    } catch (err) {
        console.error(err);
        const status = (err.status === 401 || err.status === 403) ? err.status : 502;
        res.status(status).json({
            error: status === 403 ? 'No autorizado para este módulo' : 'No se pudo conectar con ThingsBoard.'
        });
    }
}
