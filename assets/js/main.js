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
            modalReadings: 'Lecturas registradas',
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
            modalReadings: 'Logged readings',
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
        data: {}
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
        return { Authorization: `Bearer ${getToken()}` };
    }

    function logout() {
        sessionStorage.removeItem(TOKEN_KEY);
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
        label.textContent = isLoading ? t('loginLoading') : 'Ingresar';
    }

    async function handleLoginSubmit(e) {
        e.preventDefault();
        setLoginError(null);
        setLoginLoading(true);

        const email = document.getElementById('loginEmail').value.trim();
        const password = document.getElementById('loginPassword').value;

        try {
            const { token } = await apiLogin(email, password);
            sessionStorage.setItem(TOKEN_KEY, token);
            const me = await apiMe(token);
            await startApp(me);
        } catch (err) {
            console.error(err);
            if (err.status === 401 || err.status === 400) {
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
    }

    // Intenta restaurar la sesión desde un token guardado (ej. al recargar la página)
    async function tryRestoreSession() {
        const token = getToken();
        if (!token) return false;
        try {
            const me = await apiMe(token);
            await startApp(me);
            return true;
        } catch (err) {
            sessionStorage.removeItem(TOKEN_KEY);
            return false;
        }
    }

    // ---------------------------------------------------------
    // Arranque del dashboard tras login exitoso
    // ---------------------------------------------------------
    async function startApp(me) {
        state.authority = me.authority;
        state.email = me.email;
        state.allowedModules = computeAllowedModules(me.authority, me.customerId);

        for (const key of state.allowedModules) {
            state.data[key] = { current: null, online: false, lastTs: 0, history: [] };
        }

        document.getElementById('loginOverlay').hidden = true;
        document.getElementById('appRoot').hidden = false;

        const badgeText = document.getElementById('userBadgeText');
        const roleLabel = state.authority === 'TENANT_ADMIN'
            ? (state.lang === 'es' ? 'Administrador' : 'Admin')
            : MODULES[state.allowedModules[0]]
                ? MODULES[state.allowedModules[0]].label[state.lang]
                : (state.lang === 'es' ? 'Sin módulo asignado' : 'No module assigned');
        badgeText.textContent = `${state.email} · ${roleLabel}`;

        bindControls();
        applyStaticI18n();
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
        return arr.map((p) => ({ value: parseFloat(p.value), timestamp: new Date(p.ts) }));
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
        renderHistory();
        renderChart();
        updateFooterStatus();
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
                    <span class="value-main" id="val_${key}">${mod.online ? displayVal : '—'}</span>
                    <span class="value-unit">${cfg.unit[state.lang]}</span>
                </div>
                <div class="value-meta">${state.lang === 'es' ? 'Última lectura' : 'Last reading'}: ${mod.online ? lastTime : '—'}</div>
                <button class="btn-acceder" data-module="${key}" type="button"
                    aria-label="${t('access')}: ${cfg.label[state.lang]}" ${mod.online ? '' : 'disabled'}>
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
    // Render: historial combinado
    // ---------------------------------------------------------
    function renderHistory() {
        const container = document.getElementById('historyList');
        let allEvents = [];
        for (const key of state.allowedModules) {
            state.data[key].history.forEach((ev) => {
                allEvents.push({
                    module: key,
                    label: MODULES[key].label[state.lang],
                    color: MODULES[key].color,
                    unit: MODULES[key].unit[state.lang],
                    value: formatValue(key, ev.value),
                    timestamp: ev.timestamp
                });
            });
        }
        allEvents.sort((a, b) => b.timestamp - a.timestamp);
        const latest = allEvents.slice(0, 6);

        container.innerHTML = '';
        if (latest.length === 0) {
            container.innerHTML = `<div class="history-empty">${t('historyEmpty')}</div>`;
            return;
        }
        latest.forEach((ev) => {
            const item = document.createElement('div');
            item.className = 'history-item';
            item.innerHTML = `
                <span class="history-module"><i class="fas fa-circle" style="font-size:0.5rem; color:${ev.color}; margin-right:6px;" aria-hidden="true"></i>${ev.label}</span>
                <span class="history-value">${ev.value} ${ev.unit}</span>
                <span class="history-time">${formatTime(ev.timestamp)}</span>
            `;
            container.appendChild(item);
        });
    }

    // ---------------------------------------------------------
    // Render: gráfico de barras + leyenda
    // ---------------------------------------------------------
    function renderChart() {
        const container = document.getElementById('chartBars');
        let bars = [];
        for (const key of state.allowedModules) {
            const hist = state.data[key].history.slice(0, 3);
            hist.forEach((ev) => bars.push({ module: key, value: ev.value }));
        }

        container.innerHTML = '';
        bars.forEach((bar) => {
            const cfg = MODULES[bar.module];
            let height = 20 + (bar.value / cfg.max) * 100;
            height = Math.min(120, Math.max(20, height));
            const item = document.createElement('div');
            item.className = 'bar-item';
            item.innerHTML = `<div class="bar" style="height:${height}px; background:${cfg.color};" title="${cfg.label[state.lang]}: ${formatValue(bar.module, bar.value)} ${cfg.unit[state.lang]}"></div>`;
            container.appendChild(item);
        });

        const legend = document.getElementById('chartLegend');
        legend.innerHTML = state.allowedModules.map((key) => `
            <span><span class="legend-dot" style="background:${MODULES[key].color};"></span>${MODULES[key].label[state.lang]}</span>
        `).join('');
    }

    // ---------------------------------------------------------
    // Modal de detalle de módulo
    // ---------------------------------------------------------
    function openModuleModal(moduleId) {
        const cfg = MODULES[moduleId];
        const mod = state.data[moduleId];
        const modal = document.getElementById('moduleModal');
        document.getElementById('modalTitle').textContent = cfg.label[state.lang];

        const rows = [
            [t('modalDevice'), moduleId.toUpperCase() + '-01'],
            [t('modalStatus'), mod.online ? t('online') : t('offline')],
            [t('modalLastValue'), mod.online ? `${formatValue(moduleId, mod.current)} ${cfg.unit[state.lang]}` : '—'],
            [t('modalReadings'), String(mod.history.length)]
        ];

        if (state.authority === 'TENANT_ADMIN') {
            const avg = mod.history.length
                ? mod.history.reduce((s, e) => s + e.value, 0) / mod.history.length
                : 0;
            rows.push([state.lang === 'es' ? 'Promedio (últimas)' : 'Average (recent)', `${avg.toFixed(cfg.decimals)} ${cfg.unit[state.lang]}`]);
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
        renderHistory();
        renderChart();
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
