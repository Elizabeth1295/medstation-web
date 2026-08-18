import { query } from './_db.js';
import { requireUser } from './_auth.js';

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const session = await requireUser(req, res);
    if (!session) return;

    try {
        if (req.method === 'GET') {
            const patientCode = session.kind === 'patient'
                ? session.patientCode
                : String(req.query.patientCode || '').trim().toUpperCase();
            const params = [];
            let where = 'WHERE m.value > 0';
            if (patientCode) {
                params.push(patientCode);
                where += ' AND p.patient_code = $1';
            }
            const result = await query(`
                SELECT m.id, p.patient_code,
                       COALESCE(NULLIF(CONCAT_WS(' ', p.first_name, p.last_name), ''), p.name, p.username) AS patient_name,
                       s.station_code, s.name AS station_name,
                       m.value, m.unit, m.measured_at
                FROM measurements m
                JOIN patients p ON p.id = m.patient_id
                JOIN stations s ON s.id = m.station_id
                ${where}
                ORDER BY ${session.kind === 'patient' ? 's.name, m.measured_at DESC' : 'm.measured_at DESC'}
                LIMIT 100
            `, params);
            return res.status(200).json(result.rows);
        }

        if (req.method === 'POST') {
            if (session.kind !== 'admin') {
                return res.status(403).json({ error: 'Solo un administrador puede guardar mediciones' });
            }
            const patientCode = String(req.body?.patientCode || '').trim().toUpperCase();
            const stationCode = String(req.body?.stationCode || '').trim().toUpperCase();
            const value = Number(req.body?.value);
            const unit = String(req.body?.unit || '').trim() || null;
            if (!patientCode || !stationCode || !Number.isFinite(value)) {
                return res.status(400).json({ error: 'Paciente, estación o valor inválido' });
            }

            const result = await query(`
                INSERT INTO measurements (patient_id, station_id, value, unit)
                SELECT p.id, s.id, $3, $4
                FROM patients p CROSS JOIN stations s
                WHERE p.patient_code = $1 AND s.station_code = $2
                RETURNING id, value, unit, measured_at
            `, [patientCode, stationCode, value, unit]);
            if (!result.rows.length) {
                return res.status(404).json({ error: 'Paciente o estación no encontrados' });
            }
            return res.status(201).json(result.rows[0]);
        }

        return res.status(405).json({ error: 'Método no permitido' });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'No se pudo acceder a la base de datos' });
    }
}
