// ================================================================
//  MÓDULO PRINCIPAL – Integración real con ThingsBoard + Login
//  - Login vía REST API (JWT en sessionStorage)
//  - Filtrado de módulos según rol real (Tenant Admin vs Customer User)
//  - Poll periódico de telemetría autenticado
//  - Soporta idioma ES/EN
// ================================================================

(function () {
    'use strict';

    // ---------------------------------------------------------
    // Configuración de conexión
    // ---------------------------------------------------------
    const APP_CONFIG = {
        apiBase: '/api/telemetry',
        pollIntervalMs: 5000,
        offlineThresholdMs: 15000,
        historyLimit: 10
    };

    const TOKEN_KEY = 'tb_token';

    // Mapea cada Customer de ThingsBoard a su módulo visual.
    // (Grupo Espirometro / Composicion Corporal / Estres)
    const CUSTOMER_MODULE_MAP = {
        '9d6a8eb0-954e-11f1-a210-4586a442bb3a': 'spiro',
        'a6676e20-954e-11f1-a210-4586a442bb3a': 'body',
        'ac5fe730-954e-11f1-a210-4586a442bb3a': 'stress'
    };

    // ---------------------------------------------------------
    // Configuración de módulos (visual / i18n)
    // ---------------------------------------------------------
    const MODULES = {
        spiro: {
            label: { es: 'Espirómetro', en: 'Spirometer' },
            icon: 'fa-lungs',
            color: '#1d7cf0',
            unit: { es: 'L', en: 'L' },
            decimals: 2,
            max: 5
        },
        body: {
            label: { es: 'Composición corporal', en: 'Body composition' },
            icon: 'fa-weight',
            color: '#20b2aa',
            unit: { es: '% grasa', en: '% fat' },
            decimals: 1,
            max: 35
        },
        stress: {
            label: { es: 'Analizador de estrés', en: 'Stress analyzer' },
            icon: 'fa-brain',
            color: '#f09b5a',
            unit: { es: '% HRV', en: '% HRV' },
            decimals: 0,
            max: 100
        }
    };

    const ALL_MODULE_KEYS = Object.keys(MODULES);

    const I18N = {
        es: {
            chartTitle: 'Mediciones recientes',
            historyTitle: 'Historial',
            footerModules: 'módulos conectados',
            footerServer: 'servidor activo',
            footerDisclaimer: 'Uso académico',
            access: 'Acceder',
            offline: 'Sin conexión',
            online: 'En línea',
            historyEmpty: 'Aún no hay registros',
            modalDevice: 'Dispositivo',
            modalStatus: 'Estado',
            modalReadings: 'Lecturas válidas recientes',
            modalLastValue: 'Último valor',
            close: 'Cerrar',
            loginError: 'Correo o contraseña incorrectos',
            loginConnError: 'No se pudo conectar con el servidor',
            loginLoading: 'Ingresando…'
        },
        en: {
            chartTitle: 'Recent measurements',
            historyTitle: 'History',
            footerModules: 'modules connected',
            footerServer: 'server active',
            footerDisclaimer: 'Academic use',
            access: 'Open',
            offline: 'Offline',
            online: 'Online',
            historyEmpty: 'No readings yet',
            modalDevice: 'Device',
            modalStatus: 'Status',
            modalReadings: 'Recent valid readings',
            modalLastValue: 'Last value',
            close: 'Close',
            loginError: 'Incorrect email or password',
            loginConnError: 'Could not connect to the server',
            loginLoading: 'Signing in…'
        }
    };

    // ---------------------------------------------------------
    // Estado global de la aplicación
    // ---------------------------------------------------------
    const state = {
        lang: 'es',
        authority: null,      // 'TENANT_ADMIN' | 'CUSTOMER_USER'
        email: null,
        allowedModules: [],   // subconjunto de ALL_MODULE_KEYS visible para este usuario
        data: {},
        patients: [],
        selectedPatientCode: '',
        measurements: []
    };

    function t(key) {
        return I18N[state.lang][key] || key;
    }

    function formatValue(moduleId, value) {
        const cfg = MODULES[moduleId];
        if (value === null || value === undefined) return '—';
        return Number(value).toFixed(cfg.decimals);
    }

    function formatTime(date) {
        return date.toLocaleTimeString(state.lang === 'es' ? 'es-CR' : 'en-US', {
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    // ---------------------------------------------------------
    // Sesión: login, logout, restauración
    // ---------------------------------------------------------
    function getToken() {
        return sessionStorage.getItem(TOKEN_KEY);
    }

    function authHeader() {
        const token = getToken();
        return token ? { Authorization: `Bearer ${token}` } : {};
    }

    async function logout() {
        sessionStorage.removeItem(TOKEN_KEY);
        await fetch('/api/patient-logout', { method: 'POST' }).catch(() => {});
        location.reload();
    }

    async function apiLogin(email, password) {
        const res = await fetch('/api/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: email, password })
        });
        if (!res.ok) {
            const err = new Error('login_failed');
            err.status = res.status;
            throw err;
        }
        return res.json(); // { token, refreshToken }
    }

    async function apiMe(token) {
        const res = await fetch('/api/me', {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) {
            const err = new Error('me_failed');
            err.status = res.status;
            throw err;
        }
        return res.json(); // { authority, customerId, email }
    }

    function computeAllowedModules(authority, customerId) {
        if (authority === 'TENANT_ADMIN') return ALL_MODULE_KEYS.slice();
        const moduleKey = CUSTOMER_MODULE_MAP[customerId];
        return moduleKey ? [moduleKey] : [];
    }

    function setLoginError(msg) {
        const el = document.getElementById('loginError');
        if (!msg) {
            el.hidden = true;
            el.textContent = '';
        } else {
            el.hidden = false;
            el.textContent = msg;
        }
    }

    function setLoginLoading(isLoading) {
        const btn = document.getElementById('loginSubmit');
        const label = document.getElementById('loginSubmitLabel');
        btn.disabled = isLoading;
        const registering = document.getElementById('loginMode').value === 'register';
        label.textContent = isLoading ? (registering ? 'Creando cuenta…' : t('loginLoading')) : (registering ? 'Crear cuenta' : 'Ingresar');
    }

    function updateLoginMode(clearCredentials = false) {
        const mode = document.getElementById('loginMode').value;
        if (clearCredentials) {
            document.getElementById('loginEmail').value = '';
            document.getElementById('loginPassword').value = '';
            document.getElementById('registerName').value = '';
            setLoginError(null);
        }
        const registering = mode === 'register';
        document.getElementById('registerNameGroup').hidden = !registering;
        document.getElementById('registerName').required = registering;
        document.getElementById('loginSubmitLabel').textContent = registering ? 'Crear cuenta' : 'Ingresar';
        document.getElementById('loginIdentityLabel').textContent = mode === 'patient' ? 'Correo o usuario' : 'Correo';
        document.getElementById('loginHelp').textContent = registering
            ? 'Se generará un código de paciente único para su historial.'
            : mode === 'patient'
                ? 'Ingrese con el correo y contraseña de su cuenta de paciente.'
                : 'Administradores y técnicos usan su cuenta de ThingsBoard.';
    }

    async function handleLoginSubmit(e) {
        e.preventDefault();
        setLoginError(null);
        setLoginLoading(true);

        const email = document.getElementById('loginEmail').value.trim();
        const password = document.getElementById('loginPassword').value;
        const mode = document.getElementById('loginMode').value;

        try {
            let me;
            if (mode === 'patient' || mode === 'register') {
                if (mode === 'register') {
                    const registerRes = await fetch('/api/patient-register', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            username: document.getElementById('registerName').value.trim(),
                            email,
                            password
                        })
                    });
                    const registerData = await registerRes.json().catch(() => ({}));
                    if (!registerRes.ok) {
                        const err = new Error(registerData.error || 'register_failed');
                        err.status = registerRes.status;
                        err.userMessage = registerData.error;
                        throw err;
                    }
                }
                const res = await fetch('/api/patient-login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password })
                });
                if (!res.ok) {
                    const err = new Error('login_failed');
                    err.status = res.status;
                    throw err;
                }
                me = await (await fetch('/api/patient-session')).json();
            } else {
                const { token } = await apiLogin(email, password);
                sessionStorage.setItem(TOKEN_KEY, token);
                me = await apiMe(token);
            }
            await startApp(me);
        } catch (err) {
            console.error(err);
            if (err.userMessage) {
                setLoginError(err.userMessage);
            } else if (err.status === 401 || err.status === 400) {
                setLoginError(t('loginError'));
            } else {
                setLoginError(t('loginConnError'));
            }
            sessionStorage.removeItem(TOKEN_KEY);
            setLoginLoading(false);
        }
    }

    function bindLoginForm() {
        document.getElementById('loginForm').addEventListener('submit', handleLoginSubmit);
        document.getElementById('loginMode').addEventListener('change', () => updateLoginMode(true));
        updateLoginMode();
        setTimeout(() => {
            if (document.getElementById('loginMode').value === 'admin') {
                document.getElementById('loginEmail').value = '';
                document.getElementById('loginPassword').value = '';
            }
        }, 200);
    }

    // Intenta restaurar la sesión desde un token guardado (ej. al recargar la página)
    async function tryRestoreSession() {
        const token = getToken();
        if (token) {
            try {
                const me = await apiMe(token);
                await startApp(me);
                return true;
            } catch (err) {
                sessionStorage.removeItem(TOKEN_KEY);
            }
        }
        try {
            const res = await fetch('/api/patient-session');
            if (!res.ok) return false;
            await startApp(await res.json());
            return true;
        } catch {
            return false;
        }
    }

    // ---------------------------------------------------------
    // Arranque del dashboard tras login exitoso
    // ---------------------------------------------------------
    async function startApp(me) {
        state.authority = me.authority;
        state.email = me.email;
        state.allowedModules = me.authority === 'PATIENT' ? [] : computeAllowedModules(me.authority, me.customerId);
        state.selectedPatientCode = me.authority === 'PATIENT' ? me.patientCode : '';

        for (const key of state.allowedModules) {
            state.data[key] = { current: null, online: false, lastTs: 0, history: [] };
        }

        document.getElementById('loginOverlay').hidden = true;
        document.getElementById('appRoot').hidden = false;

        const badgeText = document.getElementById('userBadgeText');
        const roleLabel = state.authority === 'PATIENT'
            ? `${me.patientCode}${me.name ? ` · ${me.name}` : ''}`
            : state.authority === 'TENANT_ADMIN'
            ? (state.lang === 'es' ? 'Administrador' : 'Admin')
            : MODULES[state.allowedModules[0]]
                ? MODULES[state.allowedModules[0]].label[state.lang]
                : (state.lang === 'es' ? 'Sin módulo asignado' : 'No module assigned');
        badgeText.textContent = state.authority === 'PATIENT'
            ? `@${me.username || 'usuario'} · ${me.patientCode} · ${state.email}`
            : `${state.email} · ${roleLabel}`;
        const isPatient = state.authority === 'PATIENT';
        document.getElementById('patientForm').hidden = isPatient;
        document.getElementById('patientFilter').hidden = isPatient;
        document.getElementById('stationAssignments').hidden = isPatient;
        document.getElementById('refreshClinicalBtn').hidden = isPatient;
        document.getElementById('patientDashboard').hidden = !isPatient;
        document.getElementById('clinicalTitle').innerHTML = isPatient
            ? '<i class="fas fa-notes-medical" aria-hidden="true"></i> Mi perfil e historial'
            : '<i class="fas fa-notes-medical" aria-hidden="true"></i> Pacientes y mediciones';
        if (isPatient) {
            document.getElementById('patientNumber').textContent = me.patientCode;
            document.getElementById('patientUsername').textContent = `@${me.username || me.email}`;
            document.getElementById('patientEmail').textContent = me.email;
            await loadPatientProfile();
        }

        bindControls();
        applyStaticI18n();
        await refreshPatients();
        await refreshAllModules();
        setInterval(refreshAllModules, APP_CONFIG.pollIntervalMs);
    }

    function showLogin() {
        document.getElementById('loginOverlay').hidden = false;
        document.getElementById('appRoot').hidden = true;
    }

    // ---------------------------------------------------------
    // Integración vía proxy serverless (/api/telemetry), autenticada
    // ---------------------------------------------------------
    async function fetchLatest(moduleId) {
        const res = await fetch(`${APP_CONFIG.apiBase}?device=${moduleId}&type=latest`, {
            headers: authHeader()
        });
        if (res.status === 401 || res.status === 403) {
            logout();
            throw new Error('session_expired');
        }
        if (!res.ok) throw new Error(`Error proxy telemetry: ${res.status}`);
        const arr = await res.json();
        if (!arr || arr.length === 0) return null;
        return { value: parseFloat(arr[0].value), ts: arr[0].ts };
    }

    async function fetchHistory(moduleId, limit) {
        const res = await fetch(`${APP_CONFIG.apiBase}?device=${moduleId}&type=history&limit=${limit}`, {
            headers: authHeader()
        });
        if (res.status === 401 || res.status === 403) {
            logout();
            throw new Error('session_expired');
        }
        if (!res.ok) throw new Error(`Error proxy telemetry: ${res.status}`);
        const arr = await res.json();
        return arr
            .map((p) => ({ value: parseFloat(p.value), timestamp: new Date(p.ts) }))
            .filter((p) => Number.isFinite(p.value) && p.value > 0);
    }

    async function refreshModule(moduleId) {
        const mod = state.data[moduleId];
        try {
            const latest = await fetchLatest(moduleId);
            if (latest) {
                mod.current = latest.value;
                mod.lastTs = latest.ts;
                mod.online = (Date.now() - latest.ts) < APP_CONFIG.offlineThresholdMs;
            } else {
                mod.online = false;
            }
            const history = await fetchHistory(moduleId, APP_CONFIG.historyLimit);
            mod.history = history;
        } catch (err) {
            if (err.message === 'session_expired') return;
            console.error(`Error actualizando ${moduleId}:`, err);
            mod.online = false;
        }
    }

    async function refreshAllModules() {
        await Promise.all(state.allowedModules.map((key) => refreshModule(key)));
        renderModules();
        updateFooterStatus();
        if (state.authority !== 'PATIENT') await refreshPatientsIfChanged();
        if (state.selectedPatientCode) await refreshMeasurements();
    }

    // ---------------------------------------------------------
    // Pacientes y mediciones persistidas en PostgreSQL
    // ---------------------------------------------------------
    async function clinicalFetch(path, options = {}) {
        const headers = { ...authHeader(), ...(options.headers || {}) };
        const res = await fetch(path, { ...options, headers });
        if (res.status === 401 || res.status === 403) {
            logout();
            throw new Error('session_expired');
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
        return data;
    }

    function setClinicalMessage(message, isError = false) {
        const el = document.getElementById('clinicalMessage');
        el.textContent = message || '';
        el.classList.toggle('is-error', isError);
    }

    // Rellena el <select> de pacientes conservando la selección actual.
    function renderPatientSelect() {
        const select = document.getElementById('patientSelect');
        select.innerHTML = '<option value="">Seleccione un paciente</option>' + state.patients.map((p) => {
            const displayName = [p.first_name, p.last_name].filter(Boolean).join(' ') || p.name || p.username || '';
            return `<option value="${p.patient_code}">${p.patient_code}${displayName ? ` · ${displayName}` : ''}</option>`;
        }).join('');
        if (state.authority === 'PATIENT' && state.patients[0]) {
            state.selectedPatientCode = state.patients[0].patient_code;
        }
        if (state.patients.some((p) => p.patient_code === state.selectedPatientCode)) {
            select.value = state.selectedPatientCode;
        } else {
            state.selectedPatientCode = '';
        }
    }

    async function refreshPatients() {
        try {
            state.patients = await clinicalFetch('/api/patients');
            renderPatientSelect();
            await refreshMeasurements();
            if (state.authority !== 'PATIENT') await loadActivePatient();
        } catch (error) {
            console.error(error);
            setClinicalMessage(error.message, true);
        }
    }

    // Refresco automático de la lista de pacientes (p. ej. uno registrado desde
    // otro dispositivo). Solo re-renderiza si la lista realmente cambió, para no
    // interrumpir al admin si está eligiendo en un desplegable.
    async function refreshPatientsIfChanged() {
        try {
            const patients = await clinicalFetch('/api/patients');
            const codes = (arr) => arr.map((p) => p.patient_code).sort().join(',');
            if (codes(patients) === codes(state.patients || [])) return;
            state.patients = patients;
            renderPatientSelect();
            if (state.authority !== 'PATIENT') await loadActivePatient();
        } catch (error) {
            console.error('No se pudo refrescar la lista de pacientes:', error);
        }
    }

    async function loadActivePatient() {
        try {
            const assignments = await clinicalFetch('/api/active-patient');
            const patientOptions = state.patients.map((p) => {
                const displayName = [p.first_name, p.last_name].filter(Boolean).join(' ') || p.name || p.username || '';
                return `<option value="${p.patient_code}">${p.patient_code}${displayName ? ` · ${displayName}` : ''}</option>`;
            }).join('');
            document.getElementById('stationAssignments').innerHTML = assignments.map((assignment) => `
                <div class="station-assignment">
                    <label for="active_${assignment.station_code}"><i class="fas fa-clinic-medical" aria-hidden="true"></i> ${assignment.station_name}</label>
                    <select class="login-input station-patient-select" id="active_${assignment.station_code}" data-station="${assignment.station_code}">
                        <option value="">Ningún paciente</option>${patientOptions}
                    </select>
                </div>
            `).join('');
            assignments.forEach((assignment) => {
                document.getElementById(`active_${assignment.station_code}`).value = assignment.patient_code || '';
            });
            setClinicalMessage('');
        } catch (error) {
            setClinicalMessage(error.message, true);
        }
    }

    async function setActivePatient(stationCode, patientCode) {
        const active = await clinicalFetch('/api/active-patient', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stationCode, patientCode })
        });
        setClinicalMessage('');
    }

    // Pieza 2: etiquetas y unidades de cada metrica que envia el modulo de body.
    // Nombres de clave reales del modulo (confirmar los ambiguos con el equipo).
    const METRIC_LABELS = {
        // Body
        peso: ['Peso', 'kg'], gp: ['Grasa', '%'], gk: ['Grasa', 'kg'],
        ffm: ['Masa magra', 'kg'], tbw: ['Agua total', 'L'], tp: ['Agua', '%'],
        mus: ['Músculo', 'kg'], mme: ['Masa músc.', 'kg'], hue: ['Hueso', 'kg'],
        pro: ['Proteína', 'kg'], imc: ['IMC', ''], bmr: ['Metab.', 'kcal'],
        R: ['R', 'Ω'], X: ['X', 'Ω'], F: ['Fase', '°'],
        // Espirómetro
        fvc_L: ['FVC', 'L'], fev1_L: ['FEV1', 'L'],
        fev1_fvc_pct: ['FEV1/FVC', '%'], pef_Ls: ['PEF', 'L/s'],
        // Estrés
        fc: ['FC', 'lpm'], spo2: ['SpO2', '%'],
        eda: ['EDA', ''], temp: ['Temp', '°C']
    };

    function metricsHtml(measurement) {
        const metrics = measurement.metrics;
        if (!metrics || typeof metrics !== 'object') return '';
        // Solo se muestran las metricas reconocidas (con etiqueta); asi se
        // oculta el "ruido" del modulo (calidad, maniobra, grupo, aviso, etc.).
        const keys = Object.keys(metrics).filter((k) => METRIC_LABELS[k] && metrics[k] != null);
        if (!keys.length) return '';
        const chips = keys.map((k) => {
            const [label, unit] = METRIC_LABELS[k] || [k, ''];
            const raw = metrics[k];
            // Hasta 2 decimales, sin ceros de relleno (4.02, 3.61, 90, 8.5).
            const val = typeof raw === 'number' ? String(Number(raw.toFixed(2))) : raw;
            return `<span class="metric-chip">${label}: <strong>${val}</strong>${unit ? ' ' + unit : ''}</span>`;
        }).join('');
        return `<div class="metric-chips">${chips}</div>`;
    }

    // --- Diagnóstico asistido por IA -----------------------------------------
    const DIAGNOSIS_HINT = 'Genere un análisis del historial del paciente con posibles anomalías y recomendaciones.';

    // Muestra la tarjeta solo cuando hay un paciente seleccionado, y limpia el
    // resultado si se cambió de paciente (para no mezclar diagnósticos).
    function updateDiagnosisVisibility() {
        const card = document.getElementById('diagnosisCard');
        if (!card) return;
        if (!state.selectedPatientCode) {
            card.hidden = true;
            card.dataset.patient = '';
            return;
        }
        card.hidden = false;
        if (card.dataset.patient !== state.selectedPatientCode) {
            card.dataset.patient = state.selectedPatientCode;
            const bodyEl = document.getElementById('diagnosisBody');
            if (bodyEl) bodyEl.innerHTML = `<p class="diagnosis-hint">${DIAGNOSIS_HINT}</p>`;
        }
    }

    // Da formato mínimo al texto de la IA: escapa HTML y resalta **negritas**.
    // Los saltos de línea se respetan con CSS (white-space: pre-wrap).
    function formatDiagnosis(text) {
        return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    }

    async function generateDiagnosis() {
        if (!state.selectedPatientCode) return;
        const btn = document.getElementById('generateDiagnosisBtn');
        const bodyEl = document.getElementById('diagnosisBody');
        const prevLabel = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Generando…';
        bodyEl.innerHTML = '<p class="diagnosis-hint">Analizando el historial con IA… esto puede tardar unos segundos.</p>';
        try {
            const result = await clinicalFetch('/api/diagnosis', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ patientCode: state.selectedPatientCode })
            });
            const when = result.generatedAt ? new Date(result.generatedAt).toLocaleString('es-CR') : '';
            bodyEl.innerHTML = `<div class="diagnosis-text">${formatDiagnosis(result.diagnosis)}</div>
                <p class="diagnosis-meta">Modelo: ${escapeHtml(result.model || 'IA')}${when ? ' · ' + when : ''}</p>`;
        } catch (error) {
            bodyEl.innerHTML = `<p class="diagnosis-error">${escapeHtml(error.message)}</p>`;
        } finally {
            btn.disabled = false;
            btn.innerHTML = prevLabel;
        }
    }

    async function refreshMeasurements() {
        const body = document.getElementById('measurementsBody');
        const patientView = state.authority === 'PATIENT';
        updateDiagnosisVisibility();
        if (!state.selectedPatientCode) {
            state.measurements = [];
            body.innerHTML = '<div class="history-empty">Seleccione un paciente para ver su historial.</div>';
            return;
        }
        try {
            state.measurements = await clinicalFetch(`/api/measurements?patientCode=${encodeURIComponent(state.selectedPatientCode)}`);
            if (!state.measurements.length) {
                body.innerHTML = '<div class="history-empty">Este paciente aún no tiene mediciones guardadas.</div>';
                return;
            }

            const openStations = new Set(
                [...body.querySelectorAll('details[open]')].map((el) => el.dataset.station)
            );
            const groups = new Map();
            state.measurements.forEach((measurement) => {
                if (!groups.has(measurement.station_code)) groups.set(measurement.station_code, []);
                groups.get(measurement.station_code).push(measurement);
            });

            const stationOrder = ['SPIRO-01', 'BODY-01', 'STRESS-01'];
            const orderedGroups = [...groups.entries()].sort((a, b) =>
                stationOrder.indexOf(a[0]) - stationOrder.indexOf(b[0])
            );
            body.innerHTML = orderedGroups.map(([stationCode, rows]) => {
                const latest = rows[0];
                const open = openStations.has(stationCode);
                const headers = patientView
                    ? '<th>Valor</th><th>Fecha</th>'
                    : '<th>Paciente</th><th>Valor</th><th>Fecha</th>';
                const tableRows = rows.map((m) => {
                    const dateStr = new Date(m.measured_at).toLocaleString('es-CR');
                    const valueCell = `<strong>${Number(m.value).toFixed(2)}</strong> ${m.unit || ''}${metricsHtml(m)}`;
                    return patientView
                        ? `<tr><td>${valueCell}</td><td>${dateStr}</td></tr>`
                        : `<tr><td>${m.patient_code}${m.patient_name ? `<small>${m.patient_name}</small>` : ''}</td><td>${valueCell}</td><td>${dateStr}</td></tr>`;
                }).join('');
                return `
                    <details class="station-accordion" data-station="${stationCode}" ${open ? 'open' : ''}>
                        <summary>
                            <span><i class="fas fa-clinic-medical" aria-hidden="true"></i> ${latest.station_name}</span>
                            <span class="station-summary-meta">${rows.length} registros · Último: ${Number(latest.value).toFixed(2)} ${latest.unit || ''}</span>
                        </summary>
                        <div class="measurements-table-wrap">
                            <table class="measurements-table"><thead><tr>${headers}</tr></thead><tbody>${tableRows}</tbody></table>
                        </div>
                    </details>`;
            }).join('');
        } catch (error) {
            console.error(error);
            setClinicalMessage(error.message, true);
        }
    }

    // --- Cuestionario de rutina del paciente ---------------------------------
    // 8 condiciones previas (si/no). La clave debe coincidir con el backend.
    const SCREENING_CONDITIONS = [
        ['low_sleep', '¿Durmió menos de 6 horas anoche?'],
        ['caffeine', '¿Consumió cafeína en las últimas 3 horas?'],
        ['nic_alcohol', '¿Consumió nicotina o alcohol en las últimas 3 horas?'],
        ['exercise', '¿Hizo ejercicio intenso en las últimas 2 horas?'],
        ['heart_meds', '¿Toma medicación que afecte el corazón o la sudoración?'],
        ['cardiac_skin', '¿Tiene una condición cardiaca o de la piel diagnosticada?'],
        ['ate_bathed', '¿Comió o se bañó en la última hora?'],
        ['temp_discomfort', '¿Siente que la temperatura del lugar es incómoda?']
    ];
    // PSS-10: [clave, texto, invertida]. Las invertidas puntúan (4 - respuesta).
    const PSS_ITEMS = [
        ['q1', '¿Se ha sentido afectado/a por algo que ocurrió inesperadamente?', false],
        ['q2', '¿Ha sentido que no podía controlar las cosas importantes de su vida?', false],
        ['q3', '¿Se ha sentido nervioso/a o estresado/a?', false],
        ['q4', '¿Ha confiado en su capacidad para manejar sus problemas personales?', true],
        ['q5', '¿Ha sentido que las cosas le van bien?', true],
        ['q6', '¿Ha sentido que no podía afrontar todas las cosas que tenía que hacer?', false],
        ['q7', '¿Ha podido controlar las dificultades o fastidios de su vida?', true],
        ['q8', '¿Ha sentido que tenía todo bajo control?', true],
        ['q9', '¿Se ha enfadado por cosas que estaban fuera de su control?', false],
        ['q10', '¿Ha sentido que las dificultades se acumulaban tanto que no podía superarlas?', false]
    ];
    const PSS_SCALE = ['0 · Nunca', '1 · Casi nunca', '2 · De vez en cuando', '3 · A menudo', '4 · Muy a menudo'];

    function escapeHtml(text) {
        return String(text).replace(/[&<>"]/g, (ch) =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    }

    // Construye una sola vez el HTML del cuestionario dentro del formulario.
    function buildScreeningUI() {
        const host = document.getElementById('screeningFields');
        if (!host || host.dataset.built) return;

        const condRows = SCREENING_CONDITIONS.map(([key, text]) => `
            <div class="screening-row">
                <span class="screening-q">${escapeHtml(text)}</span>
                <div class="screening-yn">
                    <label><input type="radio" name="cond_${key}" value="1"> Sí</label>
                    <label><input type="radio" name="cond_${key}" value="0"> No</label>
                </div>
            </div>`).join('');

        const pssOptions = PSS_SCALE.map((lbl, i) => `<option value="${i}">${lbl}</option>`).join('');
        const pssRows = PSS_ITEMS.map(([key, text]) => `
            <div class="screening-row">
                <span class="screening-q">${escapeHtml(text)}</span>
                <select class="login-input screening-pss" name="pss_${key}">
                    <option value="">—</option>${pssOptions}
                </select>
            </div>`).join('');

        host.innerHTML = `
            <h3>Cuestionario previo (Sí / No)</h3>
            <p class="screening-help">Conteste antes de su medición de estrés.</p>
            ${condRows}
            <h3>Escala de Estrés Percibido (PSS-10)</h3>
            <p class="screening-help">En el último mes, ¿con qué frecuencia…? (0 Nunca – 4 Muy a menudo)</p>
            ${pssRows}
            <p class="screening-score" id="pssScoreLine" aria-live="polite"></p>`;
        host.dataset.built = '1';
        host.addEventListener('change', updatePssScorePreview);
    }

    // Muestra el puntaje PSS-10 en vivo (mismo cálculo que el servidor).
    function updatePssScorePreview() {
        const line = document.getElementById('pssScoreLine');
        if (!line) return;
        let total = 0;
        let answered = 0;
        for (const [key, , reverse] of PSS_ITEMS) {
            const el = document.querySelector(`[name="pss_${key}"]`);
            if (!el || el.value === '') continue;
            const value = Number(el.value);
            answered += 1;
            total += reverse ? 4 - value : value;
        }
        line.textContent = answered === PSS_ITEMS.length
            ? `Puntaje PSS-10: ${total} / 40`
            : `Puntaje PSS-10: responda las ${PSS_ITEMS.length} preguntas (${answered}/${PSS_ITEMS.length}).`;
    }

    async function loadPatientProfile() {
        try {
            const profile = await clinicalFetch('/api/patient-profile');
            document.getElementById('profileFirstName').value = profile.first_name || '';
            document.getElementById('profileLastName').value = profile.last_name || '';
            document.getElementById('profileAge').value = profile.age || '';
            document.getElementById('profileSex').value = profile.sex || '';
            document.getElementById('profileHeight').value = profile.height_cm || '';

            buildScreeningUI();
            const screening = profile.screening || {};
            const conditions = screening.conditions || {};
            for (const [key] of SCREENING_CONDITIONS) {
                const value = conditions[key];
                if (value === true || value === false) {
                    const el = document.querySelector(`[name="cond_${key}"][value="${value ? '1' : '0'}"]`);
                    if (el) el.checked = true;
                }
            }
            const pss = screening.pss || {};
            for (const [key] of PSS_ITEMS) {
                if (key in pss) {
                    const el = document.querySelector(`[name="pss_${key}"]`);
                    if (el) el.value = String(pss[key]);
                }
            }
            updatePssScorePreview();
        } catch (error) {
            setClinicalMessage(error.message, true);
        }
    }

    // Recolecta las respuestas del cuestionario desde el formulario.
    function collectScreening() {
        const conditions = {};
        for (const [key] of SCREENING_CONDITIONS) {
            const checked = document.querySelector(`[name="cond_${key}"]:checked`);
            if (checked) conditions[key] = checked.value === '1';
        }
        const pss = {};
        for (const [key] of PSS_ITEMS) {
            const el = document.querySelector(`[name="pss_${key}"]`);
            if (el && el.value !== '') pss[key] = Number(el.value);
        }
        return { conditions, pss };
    }

    async function savePatientProfile(event) {
        event.preventDefault();
        try {
            await clinicalFetch('/api/patient-profile', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    firstName: document.getElementById('profileFirstName').value,
                    lastName: document.getElementById('profileLastName').value,
                    age: Number(document.getElementById('profileAge').value),
                    sex: document.getElementById('profileSex').value,
                    heightCm: Number(document.getElementById('profileHeight').value),
                    screening: collectScreening()
                })
            });
            setClinicalMessage('Información personal guardada.');
        } catch (error) {
            setClinicalMessage(error.message, true);
        }
    }

    async function addPatient(event) {
        event.preventDefault();
        const patientCode = document.getElementById('patientCode').value.trim();
        const name = document.getElementById('patientName').value.trim();
        const email = document.getElementById('patientEmail').value.trim();
        const password = document.getElementById('patientPassword').value;
        try {
            const patient = await clinicalFetch('/api/patients', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ patientCode, name, email, password })
            });
            state.selectedPatientCode = patient.patient_code;
            event.target.reset();
            setClinicalMessage(`Paciente ${patient.patient_code} guardado.`);
            await refreshPatients();
        } catch (error) {
            setClinicalMessage(error.message, true);
        }
    }

    // ---------------------------------------------------------
    // Render: tarjetas de módulos
    // ---------------------------------------------------------
    function renderModules() {
        const grid = document.getElementById('modulesGrid');
        grid.innerHTML = '';

        state.allowedModules.forEach((key) => {
            const cfg = MODULES[key];
            const mod = state.data[key];
            const card = document.createElement('div');
            card.className = 'module-card' + (mod.online ? '' : ' is-offline');
            card.dataset.module = key;

            const statusClass = mod.online ? 'online' : 'offline';
            const statusLabel = mod.online ? t('online') : t('offline');
            const displayVal = formatValue(key, mod.current);
            const lastTime = mod.history[0] ? formatTime(mod.history[0].timestamp) : '—';

            card.innerHTML = `
                <div class="card-header">
                    <span class="card-title"><i class="fas ${cfg.icon}" aria-hidden="true"></i> ${cfg.label[state.lang]}</span>
                    <span class="module-status ${statusClass}">
                        <span class="status-dot" aria-hidden="true"></span>${statusLabel}
                    </span>
                </div>
                <div class="value-display">
                    <span class="value-main" id="val_${key}">${mod.current !== null ? displayVal : '—'}</span>
                    <span class="value-unit">${cfg.unit[state.lang]}</span>
                </div>
                <div class="value-meta">${state.lang === 'es' ? 'Última lectura' : 'Last reading'}: ${lastTime}</div>
                <button class="btn-acceder" data-module="${key}" type="button"
                    aria-label="${t('access')}: ${cfg.label[state.lang]}">
                    ${t('access')}
                </button>
            `;
            grid.appendChild(card);
        });

        grid.querySelectorAll('.btn-acceder').forEach((btn) => {
            btn.addEventListener('click', function () {
                openModuleModal(this.dataset.module);
            });
        });
    }

    // ---------------------------------------------------------
    // Modal de detalle de módulo
    // ---------------------------------------------------------
    async function openModuleModal(moduleId) {
        const cfg = MODULES[moduleId];
        const mod = state.data[moduleId];
        const modal = document.getElementById('moduleModal');
        document.getElementById('modalTitle').textContent = cfg.label[state.lang];

        let patientLabel = 'Sin paciente asignado';
        if (state.authority === 'TENANT_ADMIN' && mod.lastTs) {
            const stationCodes = { spiro: 'SPIRO-01', body: 'BODY-01', stress: 'STRESS-01' };
            try {
                const saved = await clinicalFetch(`/api/latest-station-measurement?stationCode=${stationCodes[moduleId]}`);
                if (saved && Number(saved.source_ts) === Number(mod.lastTs)) {
                    patientLabel = `${saved.patient_code}${saved.patient_name ? ` · ${saved.patient_name}` : ''}`;
                }
            } catch (error) {
                console.error(error);
                patientLabel = 'No disponible';
            }
        }

        const rows = [
            [t('modalDevice'), moduleId.toUpperCase() + '-01'],
            [t('modalStatus'), mod.online ? t('online') : t('offline')],
            [t('modalLastValue'), mod.current !== null
                ? `${formatValue(moduleId, mod.current)} ${cfg.unit[state.lang]}`
                : '—']
        ];

        if (state.authority === 'TENANT_ADMIN') {
            rows.push(['Paciente de la última medición', patientLabel]);
            rows.push(['MQTT topic', 'v1/devices/me/telemetry']);
        }

        document.getElementById('modalBody').innerHTML = rows
            .map(([k, v]) => `<div class="modal-row"><span>${k}</span><span>${v}</span></div>`)
            .join('');

        modal.hidden = false;
        document.getElementById('modalClose').focus();
    }

    function closeModal() {
        document.getElementById('moduleModal').hidden = true;
    }

    // ---------------------------------------------------------
    // Footer
    // ---------------------------------------------------------
    function updateFooterStatus() {
        const onlineCount = state.allowedModules.filter((k) => state.data[k].online).length;
        document.getElementById('moduleCount').textContent = onlineCount;
        const led = document.getElementById('serverLed');
        led.className = 'led ' + (onlineCount > 0 ? 'led-green' : 'led-red');
    }

    // ---------------------------------------------------------
    // i18n estático
    // ---------------------------------------------------------
    function applyStaticI18n() {
        document.querySelectorAll('[data-i18n]').forEach((el) => {
            el.textContent = t(el.dataset.i18n);
        });
        document.getElementById('langLabel').textContent = state.lang.toUpperCase();
    }

    function renderAll() {
        applyStaticI18n();
        renderModules();
        updateFooterStatus();
    }

    // ---------------------------------------------------------
    // Eventos de UI (solo se bindean una vez, tras login exitoso)
    // ---------------------------------------------------------
    let controlsBound = false;
    function bindControls() {
        if (controlsBound) return;
        controlsBound = true;

        document.getElementById('langToggle').addEventListener('click', function () {
            state.lang = state.lang === 'es' ? 'en' : 'es';
            this.setAttribute('aria-pressed', state.lang === 'en' ? 'true' : 'false');
            renderAll();
        });

        document.getElementById('logoutBtn').addEventListener('click', logout);
        document.getElementById('patientForm').addEventListener('submit', addPatient);
        document.getElementById('profileForm').addEventListener('submit', savePatientProfile);
        document.getElementById('generateDiagnosisBtn').addEventListener('click', generateDiagnosis);
        document.getElementById('patientSelect').addEventListener('change', async function () {
            state.selectedPatientCode = this.value;
            await refreshMeasurements();
        });
        document.getElementById('stationAssignments').addEventListener('change', async function (event) {
            if (!event.target.classList.contains('station-patient-select')) return;
            try {
                await setActivePatient(event.target.dataset.station, event.target.value);
            } catch (error) {
                setClinicalMessage(error.message, true);
            }
        });
        document.getElementById('refreshClinicalBtn').addEventListener('click', refreshPatients);

        document.getElementById('modalClose').addEventListener('click', closeModal);
        document.getElementById('moduleModal').addEventListener('click', function (e) {
            if (e.target === this) closeModal();
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') closeModal();
        });
    }

    // ---------------------------------------------------------
    // Inicialización
    // ---------------------------------------------------------
    async function init() {
        bindLoginForm();
        const restored = await tryRestoreSession();
        if (!restored) showLogin();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
