import { jwtVerify } from 'jose';

const secret = new TextEncoder().encode(
    process.env.SESSION_SECRET || 'medstation-local-change-this-secret-2026'
);

function cookieValue(req, name) {
    const cookies = String(req.headers.cookie || '').split(';');
    for (const cookie of cookies) {
        const [key, ...value] = cookie.trim().split('=');
        if (key === name) return decodeURIComponent(value.join('='));
    }
    return null;
}

async function patientSession(req) {
    const token = cookieValue(req, 'medstation_patient');
    if (!token) return null;
    try {
        const { payload } = await jwtVerify(token, secret, {
            issuer: 'medstation',
            audience: 'medstation-patient'
        });
        return {
            kind: 'patient',
            patientId: Number(payload.sub),
            patientCode: payload.patientCode,
            email: payload.email,
            username: payload.username,
            name: payload.name || null
        };
    } catch {
        return null;
    }
}

async function thingsBoardSession(req) {
    const authorization = req.headers.authorization || '';
    const token = authorization.replace(/^Bearer\s+/i, '');
    if (!token) return null;
    const tbBaseUrl = process.env.TB_BASE_URL || 'http://localhost:8080';
    const response = await fetch(`${tbBaseUrl}/api/auth/user`, {
        headers: { 'X-Authorization': `Bearer ${token}` }
    });
    if (!response.ok) return null;
    return { kind: 'admin', user: await response.json() };
}

export async function requireUser(req, res) {
    try {
        const session = await thingsBoardSession(req) || await patientSession(req);
        if (!session) {
            res.status(401).json({ error: 'Sesión inválida o expirada' });
            return null;
        }
        return session;
    } catch (error) {
        console.error(error);
        res.status(502).json({ error: 'No se pudo validar la sesión' });
        return null;
    }
}

export async function requireAdmin(req, res) {
    const session = await requireUser(req, res);
    if (!session) return null;
    if (session.kind !== 'admin') {
        res.status(403).json({ error: 'Acción reservada para administradores' });
        return null;
    }
    return session;
}

export { secret };
