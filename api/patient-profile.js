import { query } from './_db.js';
import { requireUser } from './_auth.js';

const profileSelect = `
    SELECT patient_code, username, email, first_name, last_name,
           age, sex, height_cm, weight_kg
    FROM patients WHERE id = $1
`;

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
            const weightKg = Number(req.body?.weightKg);

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
            if (!Number.isFinite(weightKg) || weightKg < 2 || weightKg > 500) {
                return res.status(400).json({ error: 'El peso debe estar entre 2 y 500 kg' });
            }

            await query(`
                UPDATE patients SET first_name=$1, last_name=$2, age=$3,
                    sex=$4, height_cm=$5, weight_kg=$6
                WHERE id=$7
            `, [firstName, lastName, age, sex, heightCm, weightKg, session.patientId]);
            const result = await query(profileSelect, [session.patientId]);
            return res.status(200).json(result.rows[0]);
        }
        return res.status(405).json({ error: 'Método no permitido' });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'No se pudo guardar el perfil' });
    }
}
