import { query } from './_db.js';
import { requireUser } from './_auth.js';

// Proxy serverless hacia OpenAI. La API key SOLO vive en el servidor
// (process.env.OPENAI_API_KEY, en .env.local) y nunca se expone al navegador.
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5-nano';

const SYSTEM_PROMPT = `Eres un asistente clínico de apoyo dentro de un sistema académico (MedStation).
Recibes el perfil y el historial de mediciones de un paciente (espirometría,
composición corporal y análisis de estrés) junto con un cuestionario de rutina.

Genera un diagnóstico BREVE y fácil de leer, con exactamente esta estructura:

Estado de salud
- Un veredicto claro en UNA línea, elegido según los resultados:
  "Saludable", "Saludable con observaciones" o "Requiere atención médica".

Resumen
- 2 o 3 viñetas cortas sobre el estado general del paciente.

Hallazgos
- Viñetas de una línea con anomalías o valores fuera de rango.
- Si no hay nada relevante, escribe solo: "Sin anomalías relevantes".

Recomendaciones
- Máximo 3 viñetas, solo si hay hallazgos que lo ameriten.

Reglas estrictas:
- Español, directo y conciso. Frases cortas, sin relleno.
- Basa el veredicto SOLO en los valores entregados; no inventes datos.
- NO hagas preguntas ni ofrezcas ayuda adicional.
- NO agregues "Notas finales", cierres conversacionales ni descargos
  (la interfaz ya muestra el descargo académico).`;

// Etiquetas legibles para las condiciones del cuestionario de rutina.
const CONDITION_LABELS = {
    low_sleep: 'Durmió menos de 6 h anoche',
    caffeine: 'Consumió cafeína (<3 h)',
    nic_alcohol: 'Consumió nicotina/alcohol (<3 h)',
    exercise: 'Ejercicio intenso reciente (<2 h)',
    heart_meds: 'Medicación que afecta corazón/sudoración',
    cardiac_skin: 'Condición cardiaca o de piel diagnosticada',
    ate_bathed: 'Comió o se bañó (<1 h)',
    temp_discomfort: 'Temperatura del lugar incómoda'
};
const IGNORED_METRIC_KEYS = new Set(['value', 'id', 'persona_ok']);

// Construye un resumen de texto plano con el perfil y el historial del paciente,
// que es lo que se envía al modelo como contexto.
function buildPatientSummary(patient, measurements) {
    const lines = [];
    const name = [patient.first_name, patient.last_name].filter(Boolean).join(' ') || patient.patient_code;
    lines.push(`Paciente: ${name} (${patient.patient_code})`);
    lines.push(`Edad: ${patient.age ?? 'N/D'} años | Sexo: ${patient.sex ?? 'N/D'} | Altura: ${patient.height_cm ?? 'N/D'} cm`);

    const screening = patient.screening || {};
    const conditions = screening.conditions || {};
    const yes = Object.entries(conditions)
        .filter(([, v]) => v)
        .map(([k]) => CONDITION_LABELS[k] || k);
    if (Object.keys(conditions).length) {
        lines.push(`Condiciones previas marcadas (Sí): ${yes.length ? yes.join('; ') : 'ninguna'}`);
    }
    if (screening.pss_score != null) {
        lines.push(`Puntaje PSS-10 de estrés percibido (0-40): ${screening.pss_score}`);
    }

    lines.push('');
    lines.push('Historial de mediciones (más recientes primero):');
    const byStation = new Map();
    for (const m of measurements) {
        if (!byStation.has(m.station_name)) byStation.set(m.station_name, []);
        byStation.get(m.station_name).push(m);
    }
    for (const [station, rows] of byStation) {
        lines.push(`\n[${station}] (${rows.length} registros)`);
        for (const m of rows.slice(0, 15)) {
            const date = new Date(m.measured_at).toISOString().slice(0, 16).replace('T', ' ');
            let line = `  - ${date}: valor=${m.value}${m.unit ? ' ' + m.unit : ''}`;
            if (m.metrics && typeof m.metrics === 'object') {
                const extra = Object.entries(m.metrics)
                    .filter(([k, v]) => !IGNORED_METRIC_KEYS.has(k) && v != null)
                    .map(([k, v]) => `${k}=${v}`)
                    .join(', ');
                if (extra) line += ` | ${extra}`;
            }
            lines.push(line);
        }
    }
    return lines.join('\n');
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

    const session = await requireUser(req, res);
    if (!session) return;

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        return res.status(503).json({
            error: 'Falta configurar OPENAI_API_KEY en el servidor (.env.local) y reiniciar vercel dev.'
        });
    }

    try {
        // El paciente solo puede analizar su propio historial; el admin, cualquiera.
        const patientCode = session.kind === 'patient'
            ? session.patientCode
            : String(req.body?.patientCode || '').trim().toUpperCase();
        if (!patientCode) return res.status(400).json({ error: 'Falta indicar el paciente' });

        const patientRes = await query(`
            SELECT patient_code, first_name, last_name, age, sex, height_cm, weight_kg, screening
            FROM patients WHERE patient_code = $1
        `, [patientCode]);
        const patient = patientRes.rows[0];
        if (!patient) return res.status(404).json({ error: 'Paciente no encontrado' });

        const measurementsRes = await query(`
            SELECT s.name AS station_name, s.station_code,
                   m.value, m.unit, m.measured_at, m.metrics
            FROM measurements m
            JOIN patients p ON p.id = m.patient_id
            JOIN stations s ON s.id = m.station_id
            WHERE p.patient_code = $1 AND m.value > 0
            ORDER BY m.measured_at DESC
            LIMIT 60
        `, [patientCode]);
        if (!measurementsRes.rows.length) {
            return res.status(400).json({ error: 'El paciente aún no tiene mediciones para analizar.' });
        }

        const summary = buildPatientSummary(patient, measurementsRes.rows);

        const aiResponse = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: OPENAI_MODEL,
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: summary }
                ],
                // GPT-5 Nano es un modelo de razonamiento: gasta tokens "pensando"
                // antes de responder. Con esfuerzo bajo y presupuesto amplio nos
                // aseguramos de que quede espacio para el texto del diagnostico.
                reasoning_effort: 'low',
                max_completion_tokens: 3000
            })
        });

        if (!aiResponse.ok) {
            const detail = await aiResponse.text();
            console.error('OpenAI error', aiResponse.status, detail);
            return res.status(502).json({
                error: `El servicio de IA respondió ${aiResponse.status}. Revise la API key, el saldo o el modelo.`
            });
        }

        const data = await aiResponse.json();
        const diagnosis = data?.choices?.[0]?.message?.content?.trim();
        if (!diagnosis) {
            return res.status(502).json({ error: 'La IA no devolvió contenido.' });
        }

        return res.status(200).json({
            diagnosis,
            model: OPENAI_MODEL,
            generatedAt: new Date().toISOString()
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'No se pudo generar el diagnóstico.' });
    }
}
