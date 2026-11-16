import { query } from './_db.js';
import { requireUser } from './_auth.js';

const profileSelect = `
    SELECT patient_code, username, email, first_name, last_name,
           age, sex, height_cm, weight_kg, screening
    FROM patients WHERE id = $1
`;

// Claves del cuestionario de rutina (deben coincidir con el frontend y con
// las que el modulo de stress lee como "shared attributes" en ThingsBoard).
const CONDITION_KEYS = [
    'low_sleep', 'caffeine', 'nic_alcohol', 'exercise',
    'heart_meds', 'cardiac_skin', 'ate_bathed', 'temp_discomfort'
];
const PSS_KEYS = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9', 'q10'];
// Items invertidos del PSS-10: su puntaje es (4 - respuesta).
const PSS_REVERSE = new Set(['q4', 'q5', 'q7', 'q8']);

// Normaliza y valida lo que manda el cliente; calcula el puntaje PSS en el
// servidor (no se confia en el total del cliente). Devuelve null si no vino nada.
function buildScreening(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const conditions = {};
    const srcCond = (raw.conditions && typeof raw.conditions === 'object') ? raw.conditions : {};
    for (const key of CONDITION_KEYS) {
        if (key in srcCond) conditions[key] = Boolean(srcCond[key]);
    }

    const pss = {};
    const srcPss = (raw.pss && typeof raw.pss === 'object') ? raw.pss : {};
    for (const key of PSS_KEYS) {
        const value = Number(srcPss[key]);
        if (Number.isInteger(value) && value >= 0 && value <= 4) pss[key] = value;
    }

    // Puntaje total solo si estan las 10 respuestas (rango 0-40).
    let pssScore = null;
    if (PSS_KEYS.every((key) => key in pss)) {
        pssScore = PSS_KEYS.reduce(
            (sum, key) => sum + (PSS_REVERSE.has(key) ? 4 - pss[key] : pss[key]), 0);
    }

    return { conditions, pss, pss_score: pssScore, updated_at: new Date().toISOString() };
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const session = await requireUser(req, res);
    if (!session) return;
    if (session.kind !== 'patient') return res.status(403).json({ error: 'Perfil disponible solo para pacientes' });

    try {
        if (req.method === 'GET') {
            const result = await query(profileSelect, [session.patientId]);
            return res.status(200).json(result.rows[0]);
        }
        if (req.method === 'PUT') {
            const firstName = String(req.body?.firstName || '').trim();
            const lastName = String(req.body?.lastName || '').trim();
            const age = Number(req.body?.age);
            const sex = String(req.body?.sex || '').toUpperCase();
            const heightCm = Number(req.body?.heightCm);

            if (!firstName || firstName.length > 100 || !lastName || lastName.length > 100) {
                return res.status(400).json({ error: 'Nombre y apellido son obligatorios' });
            }
            if (!Number.isInteger(age) || age < 1 || age > 120) {
                return res.status(400).json({ error: 'La edad debe estar entre 1 y 120 años' });
            }
            if (!['F', 'M'].includes(sex)) {
                return res.status(400).json({ error: 'Seleccione sexo F o M' });
            }
            if (!Number.isFinite(heightCm) || heightCm < 50 || heightCm > 250) {
                return res.status(400).json({ error: 'La altura debe estar entre 50 y 250 cm' });
            }

            // Cuestionario de rutina (opcional): si no viene, se conserva el anterior.
            const screening = buildScreening(req.body?.screening);

            // El peso ya no se pide a mano: lo mide y lo envia el modulo de body.
            await query(`
                UPDATE patients SET first_name=$1, last_name=$2, age=$3,
                    sex=$4, height_cm=$5,
                    screening=COALESCE($6::jsonb, screening)
                WHERE id=$7
            `, [firstName, lastName, age, sex, heightCm,
                screening === null ? null : JSON.stringify(screening),
                session.patientId]);
            const result = await query(profileSelect, [session.patientId]);
            return res.status(200).json(result.rows[0]);
        }
        return res.status(405).json({ error: 'Método no permitido' });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'No se pudo guardar el perfil' });
    }
}
