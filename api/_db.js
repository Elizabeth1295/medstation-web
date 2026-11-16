import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@127.0.0.1:5432/medstation';

const pool = new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30000
});

let schemaPromise;

export function ensureSchema() {
    if (!schemaPromise) {
        schemaPromise = pool.query(`
            CREATE TABLE IF NOT EXISTS patients (
                id SERIAL PRIMARY KEY,
                patient_code VARCHAR(50) UNIQUE NOT NULL,
                name VARCHAR(150),
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            ALTER TABLE patients ADD COLUMN IF NOT EXISTS email VARCHAR(254);
            ALTER TABLE patients ADD COLUMN IF NOT EXISTS password_hash TEXT;
            ALTER TABLE patients ADD COLUMN IF NOT EXISTS username VARCHAR(50);
            ALTER TABLE patients ADD COLUMN IF NOT EXISTS first_name VARCHAR(100);
            ALTER TABLE patients ADD COLUMN IF NOT EXISTS last_name VARCHAR(100);
            ALTER TABLE patients ADD COLUMN IF NOT EXISTS age INTEGER;
            ALTER TABLE patients ADD COLUMN IF NOT EXISTS sex CHAR(1);
            ALTER TABLE patients ADD COLUMN IF NOT EXISTS height_cm NUMERIC(5,2);
            ALTER TABLE patients ADD COLUMN IF NOT EXISTS weight_kg NUMERIC(6,2);
            -- Cuestionario de rutina del paciente: 8 condiciones previas (si/no) +
            -- escala PSS-10 (0-4 con items invertidos) + puntaje total calculado.
            ALTER TABLE patients ADD COLUMN IF NOT EXISTS screening JSONB;
            CREATE UNIQUE INDEX IF NOT EXISTS patients_email_unique
                ON patients (LOWER(email)) WHERE email IS NOT NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS patients_username_unique
                ON patients (LOWER(username)) WHERE username IS NOT NULL;

            CREATE TABLE IF NOT EXISTS stations (
                id SERIAL PRIMARY KEY,
                station_code VARCHAR(50) UNIQUE NOT NULL,
                name VARCHAR(100) NOT NULL,
                device_type VARCHAR(50) NOT NULL,
                thingsboard_device_id UUID
            );

            CREATE TABLE IF NOT EXISTS measurements (
                id BIGSERIAL PRIMARY KEY,
                patient_id INTEGER NOT NULL REFERENCES patients(id),
                station_id INTEGER NOT NULL REFERENCES stations(id),
                value DOUBLE PRECISION NOT NULL,
                unit VARCHAR(20),
                measured_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            ALTER TABLE measurements ADD COLUMN IF NOT EXISTS source_ts BIGINT;
            -- Pieza 2: guarda TODAS las metricas de una medicion (peso, grasa, FFM,
            -- agua, musculo, hueso, IMC, metabolismo, R, X, fase...) en un solo objeto.
            ALTER TABLE measurements ADD COLUMN IF NOT EXISTS metrics JSONB;
            CREATE UNIQUE INDEX IF NOT EXISTS measurements_station_source_unique
                ON measurements (station_id, source_ts) WHERE source_ts IS NOT NULL;

            CREATE TABLE IF NOT EXISTS active_patient (
                singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
                patient_id INTEGER REFERENCES patients(id),
                selected_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            INSERT INTO active_patient (singleton, patient_id)
            VALUES (TRUE, NULL) ON CONFLICT (singleton) DO NOTHING;

            INSERT INTO stations (station_code, name, device_type, thingsboard_device_id)
            VALUES ('SPIRO-01', 'Espirometro', 'spirometer', '25b60360-96d2-11f1-8613-25d51c94920b')
            ON CONFLICT (station_code) DO UPDATE SET
                name = EXCLUDED.name,
                device_type = EXCLUDED.device_type,
                thingsboard_device_id = EXCLUDED.thingsboard_device_id;

            INSERT INTO stations (station_code, name, device_type, thingsboard_device_id)
            VALUES
                ('BODY-01', 'Composicion Corporal', 'body-composition', '0421ca00-96e0-11f1-8613-25d51c94920b'),
                ('STRESS-01', 'Analizador de Estres', 'stress', '33ced630-96e0-11f1-8613-25d51c94920b')
            ON CONFLICT (station_code) DO UPDATE SET
                name = EXCLUDED.name,
                device_type = EXCLUDED.device_type,
                thingsboard_device_id = EXCLUDED.thingsboard_device_id;

            CREATE TABLE IF NOT EXISTS station_active_patient (
                station_id INTEGER PRIMARY KEY REFERENCES stations(id),
                patient_id INTEGER REFERENCES patients(id),
                selected_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            INSERT INTO station_active_patient (station_id, patient_id)
            SELECT id, NULL FROM stations
            ON CONFLICT (station_id) DO NOTHING;
        `).catch((err) => {
            schemaPromise = null;
            throw err;
        });
    }
    return schemaPromise;
}

export async function query(text, params) {
    await ensureSchema();
    return pool.query(text, params);
}
