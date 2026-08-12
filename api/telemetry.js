// ================================================================
// Proxy serverless: oculta las credenciales de ThingsBoard del
// navegador. El frontend llama a /api/telemetry?device=spiro&type=latest
// o /api/telemetry?device=spiro&type=history
// Este endpoint hace login contra ThingsBoard (usando variables de
// entorno secretas) y reenvía la telemetría al navegador.
// ================================================================

const TB_BASE_URL = process.env.TB_BASE_URL; // ej: https://api.medstation.online
const TB_USERNAME = process.env.TB_USERNAME;
const TB_PASSWORD = process.env.TB_PASSWORD;

const DEVICE_IDS = {
    spiro: '3b34e6f0-9549-11f1-a210-4586a442bb3a',
    body: '54676710-9549-11f1-a210-4586a442bb3a',
    stress: '63b60320-9549-11f1-a210-4586a442bb3a'
};

const TELEMETRY_KEY = 'value';

// Cache simple en memoria del token (vive mientras la función esté "caliente")
let cachedToken = null;
let cachedTokenExpiry = 0;

async function login() {
    const res = await fetch(`${TB_BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: TB_USERNAME, password: TB_PASSWORD })
    });
    if (!res.ok) throw new Error(`Login ThingsBoard falló: ${res.status}`);
    const json = await res.json();
    cachedToken = json.token;
    cachedTokenExpiry = Date.now() + 60 * 60 * 1000; // asumimos 1h de validez
    return cachedToken;
}

async function getToken() {
    if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;
    return login();
}

async function tbFetch(path) {
    let token = await getToken();
    let res = await fetch(`${TB_BASE_URL}${path}`, {
        headers: { 'X-Authorization': `Bearer ${token}` }
    });
    if (res.status === 401) {
        token = await login();
        res = await fetch(`${TB_BASE_URL}${path}`, {
            headers: { 'X-Authorization': `Bearer ${token}` }
        });
    }
    if (!res.ok) throw new Error(`Error ThingsBoard: ${res.status}`);
    return res.json();
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');

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
            const json = await tbFetch(path);
            res.status(200).json(json[TELEMETRY_KEY] || []);
        } else {
            const path = `/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries?keys=${TELEMETRY_KEY}`;
            const json = await tbFetch(path);
            res.status(200).json(json[TELEMETRY_KEY] || []);
        }
    } catch (err) {
        console.error(err);
        res.status(502).json({ error: 'No se pudo conectar con ThingsBoard.' });
    }
}
