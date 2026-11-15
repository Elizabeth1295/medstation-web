import { query } from './_db.js';
import { requireAdmin } from './_auth.js';

const stationOrder = `CASE s.station_code
    WHEN 'SPIRO-01' THEN 1 WHEN 'BODY-01' THEN 2 WHEN 'STRESS-01' THEN 3 ELSE 99 END`;

const TB_BASE_URL = process.env.TB_BASE_URL || 'http://localhost:8080';

// Pieza 1: empuja los datos del paciente activo (altura, edad, sexo) hacia el
// device en ThingsBoard como "shared attributes", para que el modulo (ESP32)
// los reciba automaticamente y pueda calcular, por ejemplo, el % de grasa.
// Reutiliza el token del admin logueado: ThingsBoard aplica sus propios permisos.
// Es "best-effort": si falla, la seleccion del paciente igual se guarda.
async function syncPatientAttributes(stationCode, token) {
    try {
        if (!token) return;
        const info = await query(`
            SELECT s.thingsboard_device_id AS device_id, a.patient_id,
                   p.age, p.sex, p.height_cm
            FROM station_active_patient a
            JOIN stations s ON s.id = a.station_id
            LEFT JOIN patients p ON p.id = a.patient_id
            WHERE s.station_code = $1
        `, [stationCode]);
        const row = info.rows[0];
        if (!row || !row.device_id) return;

        const url = `${TB_BASE_URL}/api/plugins/telemetry/DEVICE/${row.device_id}/SHARED_SCOPE`;
        const headers = {
            'X-Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        };

        if (!row.patient_id) {
            // Ningun paciente activo: limpia los atributos para no dejar datos viejos.
            await fetch(`${url}?keys=height,age,sex`, { method: 'DELETE', headers });
            return;
        }

        const payload = {};
        if (row.height_cm != null) payload.height = Number(row.height_cm);
        if (row.age != null) payload.age = Number(row.age);
        if (row.sex != null) payload.sex = row.sex;
        if (Object.keys(payload).length) {
            await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
        }
    } catch (err) {
        console.error('No se pudo sincronizar atributos del paciente con ThingsBoard:', err);
    }
}

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

            // Empuja altura/edad/sexo del paciente activo al modulo via ThingsBoard.
            const tbToken = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
            await syncPatientAttributes(stationCode, tbToken);

            return res.status(200).json(result.rows[0]);
        }

        return res.status(405).json({ error: 'Método no permitido' });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'No se pudo actualizar la asignación de estación' });
    }
}
