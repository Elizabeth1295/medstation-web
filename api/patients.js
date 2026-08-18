import { query } from './_db.js';
import { requireUser, requireAdmin } from './_auth.js';
import bcrypt from 'bcryptjs';

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const session = req.method === 'POST' ? await requireAdmin(req, res) : await requireUser(req, res);
    if (!session) return;

    try {
        if (req.method === 'GET') {
            const result = session.kind === 'patient'
                ? await query(`SELECT id, patient_code, name, email, created_at FROM patients WHERE id = $1`, [session.patientId])
                : await query(`SELECT id, patient_code, name, username, first_name, last_name, email, created_at FROM patients ORDER BY patient_code`);
            return res.status(200).json(result.rows);
        }

        if (req.method === 'POST') {
            const patientCode = String(req.body?.patientCode || '').trim().toUpperCase();
            const name = String(req.body?.name || '').trim() || null;
            const email = String(req.body?.email || '').trim().toLowerCase() || null;
            const password = String(req.body?.password || '');
            if (!patientCode || patientCode.length > 50) {
                return res.status(400).json({ error: 'Código de paciente inválido' });
            }
            if ((email && !password) || (!email && password) || (password && password.length < 8)) {
                return res.status(400).json({ error: 'Correo y contraseña (mínimo 8 caracteres) deben proporcionarse juntos' });
            }
            const passwordHash = password ? await bcrypt.hash(password, 12) : null;

            const result = await query(`
                INSERT INTO patients (patient_code, name, email, password_hash)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (patient_code) DO UPDATE SET
                    name = COALESCE(EXCLUDED.name, patients.name),
                    email = COALESCE(EXCLUDED.email, patients.email),
                    password_hash = COALESCE(EXCLUDED.password_hash, patients.password_hash)
                RETURNING id, patient_code, name, email, created_at
            `, [patientCode, name, email, passwordHash]);
            return res.status(201).json(result.rows[0]);
        }

        return res.status(405).json({ error: 'Método no permitido' });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'No se pudo acceder a la base de datos' });
    }
}
