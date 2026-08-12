// ================================================================
// Proxy serverless: reenvía el token de sesión del usuario logueado
// (obtenido en /api/auth) hacia ThingsBoard. Ya NO se loguea con una
// cuenta fija: así ThingsBoard aplica sus propios permisos por
// Customer y bloquea automáticamente el acceso a módulos ajenos.
// ================================================================

const TB_BASE_URL = process.env.TB_BASE_URL; // ej: https://api.medstation.online

const DEVICE_IDS = {
    spiro: '3b34e6f0-9549-11f1-a210-4586a442bb3a',
    body: '54676710-9549-11f1-a210-4586a442bb3a',
    stress: '63b60320-9549-11f1-a210-4586a442bb3a'
};

const TELEMETRY_KEY = 'value';

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
        if (type === 'history') {
            const limit = req.query.limit || 10;
            const endTs = Date.now();
            const startTs = endTs - 60 * 60 * 1000;
            const path = `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries` +
                `?keys=${TELEMETRY_KEY}&startTs=${startTs}&endTs=${endTs}&limit=${limit}&orderBy=DESC`;
            const json = await tbFetch(path, token);
            res.status(200).json(json[TELEMETRY_KEY] || []);
        } else {
            const path = `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries?keys=${TELEMETRY_KEY}`;
            const json = await tbFetch(path, token);
            res.status(200).json(json[TELEMETRY_KEY] || []);
        }
    } catch (err) {
        console.error(err);
        const status = (err.status === 401 || err.status === 403) ? err.status : 502;
        res.status(status).json({
            error: status === 403 ? 'No autorizado para este módulo' : 'No se pudo conectar con ThingsBoard.'
        });
    }
}
