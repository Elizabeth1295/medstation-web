import { query } from './_db.js';
import { requireAdmin } from './_auth.js';

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!await requireAdmin(req, res)) return;
    if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido' });

    const stationCode = String(req.query.stationCode || '').trim().toUpperCase();
    if (!stationCode) return res.status(400).json({ error: 'Falta la estación' });

    try {
        const result = await query(`
            SELECT p.patient_code,
                   COALESCE(NULLIF(CONCAT_WS(' ', p.first_name, p.last_name), ''), p.name, p.username) AS patient_name,
                   m.value, m.unit, m.measured_at, m.source_ts
            FROM measurements m
            JOIN patients p ON p.id = m.patient_id
            JOIN stations s ON s.id = m.station_id
            WHERE s.station_code = $1 AND m.value > 0
            ORDER BY m.measured_at DESC
            LIMIT 1
        `, [stationCode]);
        return res.status(200).json(result.rows[0] || null);
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'No se pudo consultar la última medición' });
    }
}
