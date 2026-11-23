import { query } from './_db.js';
import { requireUser } from './_auth.js';

// Proxy serverless hacia OpenAI. La API key SOLO vive en el servidor
// (process.env.OPENAI_API_KEY, en .env.local) y nunca se expone al navegador.
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5-nano';

const SYSTEM_PROMPT = `Eres un asistente clínico de apoyo dentro de un sistema académico (MedStation).
Recibes el perfil de un paciente y BLOQUES DE ANÁLISIS ya calculados por el
sistema (composición corporal, espirometría y estrés), cada uno con su
clasificación. Tu trabajo es reportar e interpretar esos bloques, NO recalcular.

Devuelve SOLO el diagnóstico redactado (NO repitas ni copies estas instrucciones).
Escribe BREVE y fácil de leer, usando estas cuatro secciones con estos títulos
exactos y nada más:

"Estado de salud": en la línea siguiente al título, UNA sola viñeta con el
veredicto, que es una de estas tres frases exactas: "Saludable",
"Saludable con observaciones" o "Requiere atención médica". Si hay al menos un
valor fuera de rango, no puede ser solo "Saludable".

"Resumen": 2 o 3 viñetas cortas sobre el estado general del paciente.

"Hallazgos": una viñeta por hallazgo, usando las clasificaciones YA DADAS en los
bloques (no recalcules). Cubre, cuando haya datos: composición corporal (IMC,
grasa, hidratación con su clasificación); espirometría (cada parámetro normal o
por debajo del LIN y el patrón: obstructivo, restrictivo o normal); y estrés
(banda PSS-10 y signos como frecuencia cardíaca y SpO2). Omite lo que no tenga datos.

"Recomendaciones": hasta 4 viñetas con acciones concretas (p. ej. "Tomar más
agua", "Hacer más ejercicio cardiovascular", "Técnicas de relajación si el
estrés es alto"), solo si hay hallazgos que lo ameriten.

Reglas estrictas:
- Español, directo y conciso. Frases cortas, sin relleno.
- Usa SOLO los datos y clasificaciones entregados; no inventes.
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
    F: 'Ángulo de fase (°)',
    // Espirómetro
    fvc_L: 'FVC (L)',
    fev1_L: 'FEV1 (L)',
    fev1_fvc_pct: 'FEV1/FVC (%)',
    pef_Ls: 'PEF (L/s)',
    // Estrés
    fc: 'Frecuencia cardíaca (lpm)',
    spo2: 'SpO2 (%)',
    temp: 'Temperatura de piel (°C)',
    eda: 'EDA (actividad electrodérmica)'
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

// --- Análisis de composición corporal (clasificación en el servidor) ---------
function classifyIMC(imc) {
    if (imc < 18.5) return 'bajo peso';
    if (imc < 25) return 'normal';
    if (imc < 30) return 'sobrepeso';
    return 'obesidad';
}
function classifyFat(gp, sex) {
    if (sex === 'F') return gp < 21 ? 'baja' : (gp <= 32 ? 'normal' : 'alta');
    if (sex === 'M') return gp < 8 ? 'baja' : (gp <= 24 ? 'normal' : 'alta');
    return 'sin referencia por sexo';
}
function classifyHydration(tp, sex) {
    if (sex === 'F') return tp < 50 ? 'déficit de agua' : (tp <= 55 ? 'normal' : 'alta');
    if (sex === 'M') return tp < 55 ? 'déficit de agua' : (tp <= 60 ? 'normal' : 'alta');
    return 'sin referencia por sexo';
}

function buildBodyAnalysis(patient, measurements) {
    const m = measurements.find((x) => x.station_code === 'BODY-01' && x.metrics);
    if (!m) return null;
    const sex = String(patient.sex || '').toUpperCase();
    const met = m.metrics;
    const lines = [];

    let imc = Number(met.imc);
    if (!Number.isFinite(imc)) {
        const peso = Number(met.peso);
        const hM = Number(patient.height_cm) / 100;
        if (Number.isFinite(peso) && hM > 0) imc = peso / (hM * hM);
    }
    if (Number.isFinite(imc)) lines.push(`- Peso: IMC ${imc.toFixed(1)} => ${classifyIMC(imc)}.`);

    const gp = Number(met.gp);
    if (Number.isFinite(gp)) lines.push(`- Grasa corporal: ${gp.toFixed(1)}% => ${classifyFat(gp, sex)} (sexo ${sex || 'N/D'}).`);

    const tp = Number(met.tp);
    if (Number.isFinite(tp)) lines.push(`- Hidratación: agua ${tp.toFixed(1)}% => ${classifyHydration(tp, sex)} (sexo ${sex || 'N/D'}).`);

    if (!lines.length) return null;
    return ['Análisis de composición corporal (clasificación del sistema):', ...lines].join('\n');
}

// --- Análisis de estrés (PSS-10 + signos del módulo) -------------------------
function classifyPSS(score) {
    if (score <= 13) return 'estrés percibido bajo';
    if (score <= 26) return 'estrés percibido moderado';
    return 'estrés percibido alto';
}
function classifyFC(fc) {
    if (fc < 60) return 'bradicardia (baja)';
    if (fc <= 100) return 'normal';
    return 'taquicardia (alta)';
}
function classifySpo2(s) {
    if (s >= 95) return 'normal';
    if (s >= 90) return 'levemente baja';
    return 'baja';
}

function buildStressAnalysis(patient, measurements) {
    const lines = [];

    const pss = patient.screening?.pss_score;
    if (pss != null && Number.isFinite(Number(pss))) {
        lines.push(`- PSS-10 (estrés percibido): ${pss}/40 => ${classifyPSS(Number(pss))}.`);
    }

    const m = measurements.find((x) => x.station_code === 'STRESS-01' && x.metrics);
    if (m) {
        const met = m.metrics;
        const fc = Number(met.fc);
        if (Number.isFinite(fc)) lines.push(`- Frecuencia cardíaca: ${fc.toFixed(0)} lpm => ${classifyFC(fc)}.`);
        const spo2 = Number(met.spo2);
        if (Number.isFinite(spo2)) lines.push(`- SpO2: ${spo2.toFixed(1)}% => ${classifySpo2(spo2)}.`);
        const temp = Number(met.temp);
        if (Number.isFinite(temp)) lines.push(`- Temperatura de piel: ${temp.toFixed(1)} °C.`);
        const eda = Number(met.eda);
        if (Number.isFinite(eda)) lines.push(`- EDA: ${eda} (mayor valor = mayor activación/estrés).`);
    }

    if (!lines.length) return null;
    return ['Análisis de estrés:', ...lines].join('\n');
}

// Construye un resumen de texto plano con el perfil y la ÚLTIMA medición limpia
// de cada estación (sin ruido ni duplicados), que se envía al modelo.
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
    lines.push('Última medición de cada estación (solo métricas reconocidas):');
    // measurements viene ordenado por fecha DESC, así que la primera de cada
    // estación es la más reciente. Se ignora el "ruido" (claves sin etiqueta).
    const latestByStation = new Map();
    for (const m of measurements) {
        if (!latestByStation.has(m.station_code)) latestByStation.set(m.station_code, m);
    }
    for (const m of latestByStation.values()) {
        const date = new Date(m.measured_at).toISOString().slice(0, 16).replace('T', ' ');
        let clean = '';
        if (m.metrics && typeof m.metrics === 'object') {
            clean = Object.entries(m.metrics)
                .filter(([k, v]) => METRIC_LABELS[k] && v != null)
                .map(([k, v]) => `${METRIC_LABELS[k]}=${v}`)
                .join(', ');
        }
        lines.push(`[${m.station_name}] ${date}: ${clean || `valor=${m.value}${m.unit ? ' ' + m.unit : ''}`}`);
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

        // Bloques de análisis calculados en el servidor (deterministas): el
        // modelo solo los reporta e interpreta, no recalcula.
        const blocks = [
            buildBodyAnalysis(patient, measurementsRes.rows),
            buildSpirometryTable(patient, measurementsRes.rows),
            buildStressAnalysis(patient, measurementsRes.rows)
        ].filter(Boolean);
        const summary = buildPatientSummary(patient, measurementsRes.rows) +
            (blocks.length ? '\n\n' + blocks.join('\n\n') : '');

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
