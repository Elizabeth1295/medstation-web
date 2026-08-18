import bcrypt from 'bcryptjs';
import { SignJWT } from 'jose';
import { query } from './_db.js';
import { secret } from './_auth.js';

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

    const login = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!login || !password) return res.status(400).json({ error: 'Falta usuario/correo o contraseña' });

    try {
        const result = await query(`
            SELECT id, patient_code, username, first_name, last_name, email, password_hash
            FROM patients WHERE LOWER(email) = $1 OR LOWER(username) = $1
        `, [login]);
        const patient = result.rows[0];
        if (!patient?.password_hash || !await bcrypt.compare(password, patient.password_hash)) {
            return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
        }

        const token = await new SignJWT({
            patientCode: patient.patient_code,
            email: patient.email,
            username: patient.username,
            name: [patient.first_name, patient.last_name].filter(Boolean).join(' ') || patient.username
        })
            .setProtectedHeader({ alg: 'HS256' })
            .setSubject(String(patient.id))
            .setIssuer('medstation')
            .setAudience('medstation-patient')
            .setIssuedAt()
            .setExpirationTime('8h')
            .sign(secret);

        res.setHeader('Set-Cookie', `medstation_patient=${token}; HttpOnly; Path=/; Max-Age=28800; SameSite=Lax`);
        return res.status(200).json({ patientCode: patient.patient_code, email: patient.email, username: patient.username });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'No se pudo iniciar sesión' });
    }
}
