import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { query } from './_db.js';

function validEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

    const username = String(req.body?.username || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!/^[A-Za-z0-9._-]{3,50}$/.test(username)) {
        return res.status(400).json({ error: 'El usuario debe tener 3 a 50 caracteres: letras, números, punto, guion o guion bajo' });
    }
    if (!validEmail(email) || email.length > 254) {
        return res.status(400).json({ error: 'Ingrese un correo válido' });
    }
    if (password.length < 8 || password.length > 128) {
        return res.status(400).json({ error: 'La contraseña debe tener entre 8 y 128 caracteres' });
    }

    try {
        const existing = await query('SELECT 1 FROM patients WHERE LOWER(email) = $1', [email]);
        if (existing.rows.length) {
            return res.status(409).json({ error: 'Ya existe una cuenta con ese correo' });
        }
        const existingUsername = await query('SELECT 1 FROM patients WHERE LOWER(username) = $1', [username.toLowerCase()]);
        if (existingUsername.rows.length) {
            return res.status(409).json({ error: 'Ese nombre de usuario ya está ocupado' });
        }

        const passwordHash = await bcrypt.hash(password, 12);
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const patientCode = `PAC-${randomBytes(4).toString('hex').toUpperCase()}`;
            try {
                const result = await query(`
                    INSERT INTO patients (patient_code, username, email, password_hash)
                    VALUES ($1, $2, $3, $4)
                    RETURNING patient_code, username, email
                `, [patientCode, username, email, passwordHash]);
                return res.status(201).json(result.rows[0]);
            } catch (error) {
                if (error.code !== '23505') throw error;
            }
        }
        return res.status(503).json({ error: 'No se pudo generar el código de paciente' });
    } catch (error) {
        console.error(error);
        if (error.code === '23505') return res.status(409).json({ error: 'Ya existe una cuenta con ese correo' });
        return res.status(500).json({ error: 'No se pudo registrar la cuenta' });
    }
}
