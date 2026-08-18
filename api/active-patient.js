import { query } from './_db.js';
import { requireAdmin } from './_auth.js';

const stationOrder = `CASE s.station_code
    WHEN 'SPIRO-01' THEN 1 WHEN 'BODY-01' THEN 2 WHEN 'STRESS-01' THEN 3 ELSE 99 END`;

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!await requireAdmin(req, res)) return;

    try {
        if (req.method === 'GET') {
            const result = await query(`
                SELECT s.station_code, s.name AS station_name, p.patient_code,
                       p.username, p.first_name, p.last_name, a.selected_at
                FROM station_active_patient a
                JOIN stations s ON s.id = a.station_id
                LEFT JOIN patients p ON p.id = a.patient_id
                ORDER BY ${stationOrder}
            `);
            return res.status(200).json(result.rows);
        }

        if (req.method === 'PUT') {
            const stationCode = String(req.body?.stationCode || '').trim().toUpperCase();
            const patientCode = String(req.body?.patientCode || '').trim().toUpperCase();
            if (!stationCode) return res.status(400).json({ error: 'Falta la estación' });

            const result = await query(`
                UPDATE station_active_patient a
                SET patient_id = CASE WHEN $2 = '' THEN NULL ELSE p.id END,
                    selected_at = NOW()
                FROM stations s
                LEFT JOIN patients p ON p.patient_code = NULLIF($2, '')
                WHERE a.station_id = s.id AND s.station_code = $1
                  AND ($2 = '' OR p.id IS NOT NULL)
                RETURNING s.station_code, s.name AS station_name,
                          (SELECT patient_code FROM patients WHERE id = a.patient_id) AS patient_code,
                          a.selected_at
            `, [stationCode, patientCode]);
            if (!result.rows.length) return res.status(404).json({ error: 'Estación o paciente no encontrado' });
            return res.status(200).json(result.rows[0]);
        }

        return res.status(405).json({ error: 'Método no permitido' });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'No se pudo actualizar la asignación de estación' });
    }
}
