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
- Si hay al menos un valor fuera de rango, NO uses solo "Saludable":
  usa "Saludable con observaciones" (leve) o "Requiere atención médica" (grave).

Resumen
- 2 o 3 viñetas cortas sobre el estado general del paciente.

Hallazgos
- Clasifica el PESO según el IMC: bajo peso (<18.5), normal (18.5-24.9),
  sobrepeso (25-29.9) u obesidad (>=30).
- Clasifica la GRASA corporal (%) según el sexo del paciente:
  Mujeres: baja <21, normal 21-32, alta >32.
  Hombres: baja <8, normal 8-24, alta >24.
- Evalúa la HIDRATACIÓN con el agua corporal (%):
  sano aprox. Mujeres 50-55%, Hombres 55-60%. Por debajo = posible déficit de agua.
- Una viñeta por hallazgo, de una línea. Omite lo que no tenga datos.

Espirometría (incluir esta sección SOLO si se entregó "Análisis de espirometría")
- Lista cada parámetro (FVC, FEV1, FEV1/FVC, PEF) con: medido vs esperado,
  % del esperado y si es Normal o está por debajo del LIN. Usa los valores
  YA CALCULADOS que se te entregan; no los recalcules.
- Interpretación global: patrón obstructivo (FEV1/FVC por debajo del LIN),
  posible restrictivo (FVC baja con FEV1/FVC normal), o espirometría normal.

Recomendaciones
- Acciones concretas y prácticas según los hallazgos. Ejemplos de estilo:
  "Tomar más agua durante el día", "Hacer más ejercicio cardiovascular",
  "Aumentar la ingesta de proteína", "Reducir alimentos altos en grasa".
- Máximo 3 viñetas, solo si hay hallazgos que lo ameriten.

Reglas estrictas:
- Español, directo y conciso. Frases cortas, sin relleno.
- Basa todo SOLO en los valores entregados (peso, IMC, grasa %, agua, etc.);
  no inventes datos. Usa el valor más reciente de cada métrica.
- Si hay datos de otras estaciones (espirometría, estrés), inclúyelos también.
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

// Etiquetas legibles de las métricas del módulo de body, para que el modelo
// interprete bien cada valor (no ve claves crudas como gp/tbw/imc).
const METRIC_LABELS = {
    peso: 'Peso (kg)',
    gp: 'Grasa corporal (%)',
    gk: 'Grasa (kg)',
    ffm: 'Masa magra (kg)',
    tbw: 'Agua corporal total (L)',
    tp: 'Agua corporal (%)',
    mus: 'Músculo (kg)',
    mme: 'Masa muscular esquelética (kg)',
    hue: 'Hueso (kg)',
    pro: 'Proteína (kg)',
    imc: 'IMC',
    bmr: 'Metabolismo basal (kcal)',
    R: 'Resistencia (ohm)',
    X: 'Reactancia (ohm)',
    F: 'Ángulo de fase (°)'
};

// --- Análisis de espirometría (ECSC/ERS 1993, Quanjer et al.) ----------------
// Valor esperado = a·Estatura(m) + b·Edad(años) + c
// LIN (límite inferior normal) = Esperado − 1,64·RSD.  Entre 18 y 25 años se usa 25.
// Solo es anormal estar POR DEBAJO del LIN. Claves del modulo: fvc_L, fev1_L,
// fev1_fvc_pct, pef_Ls.
const SPIRO_REF = {
    M: {
        FVC: { a: 5.76, b: -0.026, c: -4.34, rsd: 0.61, unit: 'L', key: 'fvc_L' },
        FEV1: { a: 4.3, b: -0.029, c: -2.49, rsd: 0.51, unit: 'L', key: 'fev1_L' },
        'FEV1/FVC': { a: 0, b: -0.18, c: 87.21, rsd: 7.17, unit: '%', key: 'fev1_fvc_pct' },
        PEF: { a: 6.14, b: -0.043, c: 0.15, rsd: 1.21, unit: 'L/s', key: 'pef_Ls' }
    },
    F: {
        FVC: { a: 4.43, b: -0.026, c: -2.89, rsd: 0.43, unit: 'L', key: 'fvc_L' },
        FEV1: { a: 3.95, b: -0.025, c: -2.6, rsd: 0.38, unit: 'L', key: 'fev1_L' },
        'FEV1/FVC': { a: 0, b: -0.19, c: 89.1, rsd: 6.51, unit: '%', key: 'fev1_fvc_pct' },
        PEF: { a: 5.5, b: -0.03, c: -1.11, rsd: 0.9, unit: 'L/s', key: 'pef_Ls' }
    }
};
const SPIRO_PARAMS = ['FVC', 'FEV1', 'FEV1/FVC', 'PEF'];
const SPIRO_KEYS = ['fvc_L', 'fev1_L', 'fev1_fvc_pct', 'pef_Ls'];

// Calcula la tabla Esperado/LIN/%/¿Normal? a partir de la medición de espiro
// más reciente que tenga los parámetros. Devuelve null si no hay datos usables.
function buildSpirometryTable(patient, measurements) {
    const sex = String(patient.sex || '').toUpperCase();
    const ref = SPIRO_REF[sex];
    const heightM = Number(patient.height_cm) / 100;
    let age = Number(patient.age);
    if (!ref || !Number.isFinite(heightM) || heightM <= 0 || !Number.isFinite(age)) return null;
    if (age < 25) age = 25;

    const spiro = measurements.find((m) =>
        m.station_code === 'SPIRO-01' && m.metrics &&
        SPIRO_KEYS.some((k) => m.metrics[k] != null));
    if (!spiro) return null;
    const metrics = spiro.metrics;

    const rows = [];
    for (const param of SPIRO_PARAMS) {
        const r = ref[param];
        const medido = Number(metrics[r.key]);
        if (!Number.isFinite(medido)) continue;
        const esperado = r.a * heightM + r.b * age + r.c;
        const lin = esperado - 1.64 * r.rsd;
        const pct = (medido / esperado) * 100;
        const normal = medido >= lin ? 'Sí' : 'No (por debajo del LIN)';
        rows.push(`${param} (${r.unit}) | medido=${medido.toFixed(2)} | esperado=${esperado.toFixed(2)} | LIN=${lin.toFixed(2)} | ${pct.toFixed(0)}% del esperado | Normal: ${normal}`);
    }
    if (!rows.length) return null;

    return [
        'Análisis de espirometría (ecuaciones ECSC/ERS 1993, Quanjer et al.):',
        `Datos usados: sexo ${sex}, edad ${age} años (18-25 se evalúa como 25), estatura ${heightM.toFixed(2)} m.`,
        ...rows,
        'Regla de interpretación: un parámetro solo es anormal si está POR DEBAJO de su LIN.'
    ].join('\n');
}

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
                    .map(([k, v]) => `${METRIC_LABELS[k] || k}=${v}`)
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

        const spiroTable = buildSpirometryTable(patient, measurementsRes.rows);
        const summary = buildPatientSummary(patient, measurementsRes.rows) +
            (spiroTable ? '\n\n' + spiroTable : '');

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
