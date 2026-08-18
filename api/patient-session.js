import { requireUser } from './_auth.js';

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });
    const session = await requireUser(req, res);
    if (!session) return;
    if (session.kind !== 'patient') return res.status(400).json({ error: 'No es una sesión de paciente' });
    return res.status(200).json({
        authority: 'PATIENT',
        patientCode: session.patientCode,
        email: session.email,
        username: session.username,
        name: session.name
    });
}
