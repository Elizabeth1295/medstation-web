// ================================================================
//  MÓDULO PRINCIPAL – Simulación de datos en tiempo real
//  - Genera datos aleatorios para los 3 módulos
//  - Actualiza las tarjetas, el gráfico de barras y el historial
//  - Un único ciclo de actualización (evita valores inconsistentes)
//  - Soporta idioma ES/EN y vista admin/clientes
//
//  NOTA: esta simulación es un placeholder. Cuando el servidor
//  ThingsBoard esté disponible, reemplazar generateNewData() /
//  el setInterval de simulación por una suscripción MQTT/WebSocket
//  real (ver fetchFromThingsBoard() más abajo, dejado como stub).
// ================================================================

(function () {
    'use strict';

    // ---------------------------------------------------------
    // Configuración de módulos
    // ---------------------------------------------------------
    const MODULES = {
        spiro: {
            label: { es: 'Espirómetro', en: 'Spirometer' },
            icon: 'fa-lungs',
            color: '#1d7cf0',
            base: 3.8,
            range: 0.6,
            unit: { es: 'L', en: 'L' },
            decimals: 2,
            max: 5
        },
        body: {
            label: { es: 'Composición corporal', en: 'Body composition' },
            icon: 'fa-weight',
            color: '#20b2aa',
            base: 22,
            range: 3,
            unit: { es: '% grasa', en: '% fat' },
            decimals: 1,
            max: 35
        },
        stress: {
            label: { es: 'Analizador de estrés', en: 'Stress analyzer' },
            icon: 'fa-brain',
            color: '#f09b5a',
            base: 45,
            range: 12,
            unit: { es: '% HRV', en: '% HRV' },
            decimals: 0,
            max: 100
        }
    };

    const MODULE_ORDER = Object.keys(MODULES);

    // Textos de la interfaz (i18n mínimo)
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
            close: 'Cerrar'
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
            close: 'Close'
        }
    };

    // ---------------------------------------------------------
    // Estado global de la aplicación
    // ---------------------------------------------------------
    const state = {
        lang: 'es',
        role: 'clientes',
        data: {}
    };

    for (const key of MODULE_ORDER) {
        state.data[key] = {
            current: MODULES[key].base,
            online: true,
            history: [] // { value, timestamp: Date }
        };
    }

    function t(key) {
        return I18N[state.lang][key] || key;
    }

    function formatValue(moduleId, value) {
        const cfg = MODULES[moduleId];
        return value.toFixed(cfg.decimals);
    }

    function formatTime(date) {
        return date.toLocaleTimeString(state.lang === 'es' ? 'es-CR' : 'en-US', {
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    // Genera un valor con algo de "memoria" respecto al anterior,
    // para que las lecturas se vean como una señal fisiológica real
    // y no como ruido puramente aleatorio.
    function nextValue(moduleId) {
        const cfg = MODULES[moduleId];
        const prev = state.data[moduleId].current;
        const drift = (Math.random() - 0.5) * cfg.range * 0.5;
        let val = prev + drift;
        // Mantener el valor cerca de su rango fisiológico esperado
        const min = Math.max(0, cfg.base - cfg.range);
        const max = cfg.base + cfg.range;
        val = Math.min(max, Math.max(min, val));
        return parseFloat(val.toFixed(cfg.decimals));
    }

    function initHistory() {
        const now = Date.now();
        for (const key of MODULE_ORDER) {
            for (let i = 4; i >= 0; i--) {
                const val = nextValue(key);
                state.data[key].current = val;
                state.data[key].history.unshift({ value: val, timestamp: new Date(now - i * 60000) });
            }
        }
    }

    // ---------------------------------------------------------
    // Simulación de lectura nueva (reemplazar por datos reales
    // de ThingsBoard vía WebSocket/MQTT cuando esté disponible)
    // ---------------------------------------------------------
    function generateReading(moduleId) {
        const mod = state.data[moduleId];
        if (!mod.online) return; // un módulo desconectado no reporta lecturas
        const val = nextValue(moduleId);
        mod.current = val;
        mod.history.unshift({ value: val, timestamp: new Date() });
        if (mod.history.length > 10) mod.history.pop();
    }

    // Simula caídas/reconexiones esporádicas de un módulo,
    // como ocurriría con un Raspberry Pi real perdiendo enlace MQTT.
    function maybeToggleConnectivity() {
        const key = MODULE_ORDER[Math.floor(Math.random() * MODULE_ORDER.length)];
        const mod = state.data[key];
        // Baja probabilidad de cambiar de estado en cada ciclo
        if (Math.random() < 0.06) {
            mod.online = !mod.online;
            renderModules();
            updateFooterStatus();
        }
    }

    // ---------------------------------------------------------
    // Render: tarjetas de módulos
    // ---------------------------------------------------------
    function renderModules() {
        const grid = document.getElementById('modulesGrid');
        grid.innerHTML = '';

        MODULE_ORDER.forEach((key) => {
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
        for (const key of MODULE_ORDER) {
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
        for (const key of MODULE_ORDER) {
            const hist = state.data[key].history.slice(0, 3);
            hist.forEach((ev) => bars.push({ module: key, value: ev.value }));
            while (hist.length < 3) {
                bars.push({ module: key, value: MODULES[key].base });
                hist.push(1);
            }
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
        legend.innerHTML = MODULE_ORDER.map((key) => `
            <span><span class="legend-dot" style="background:${MODULES[key].color};"></span>${MODULES[key].label[state.lang]}</span>
        `).join('');
    }

    // ---------------------------------------------------------
    // Modal de detalle de módulo (reemplaza al alert())
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

        // Vista extendida para el rol administrador
        if (state.role === 'admin') {
            const avg = mod.history.length
                ? mod.history.reduce((s, e) => s + e.value, 0) / mod.history.length
                : 0;
            rows.push([state.lang === 'es' ? 'Promedio (10 últimas)' : 'Average (last 10)', `${avg.toFixed(cfg.decimals)} ${cfg.unit[state.lang]}`]);
            rows.push(['MQTT topic', `medstation/${moduleId}/data`]);
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
    // Footer: conteo de módulos conectados y estado del servidor
    // ---------------------------------------------------------
    function updateFooterStatus() {
        const onlineCount = MODULE_ORDER.filter((k) => state.data[k].online).length;
        document.getElementById('moduleCount').textContent = onlineCount;
        const led = document.getElementById('serverLed');
        led.className = 'led ' + (onlineCount > 0 ? 'led-green' : 'led-red');
    }

    // ---------------------------------------------------------
    // Aplicar textos i18n a elementos estáticos
    // ---------------------------------------------------------
    function applyStaticI18n() {
        document.querySelectorAll('[data-i18n]').forEach((el) => {
            el.textContent = t(el.dataset.i18n);
        });
        document.getElementById('langLabel').textContent = state.lang.toUpperCase();
    }

    // ---------------------------------------------------------
    // Render completo
    // ---------------------------------------------------------
    function renderAll() {
        applyStaticI18n();
        renderModules();
        renderHistory();
        renderChart();
        updateFooterStatus();
    }

    // ---------------------------------------------------------
    // Ciclo único de actualización de datos (cada 3s)
    // ---------------------------------------------------------
    function tick() {
        const key = MODULE_ORDER[Math.floor(Math.random() * MODULE_ORDER.length)];
        generateReading(key);
        maybeToggleConnectivity();
        renderModules();
        renderHistory();
        renderChart();
    }

    // ---------------------------------------------------------
    // Stub para integración futura con ThingsBoard
    // (dejarlo aquí facilita el reemplazo de la simulación
    // sin tocar el resto del render)
    // ---------------------------------------------------------
    // async function fetchFromThingsBoard() {
    //     const res = await fetch('/api/plugins/telemetry/DEVICE/{deviceId}/values/timeseries');
    //     const json = await res.json();
    //     // mapear json a state.data[...] y llamar renderModules()/renderHistory()/renderChart()
    // }

    // ---------------------------------------------------------
    // Eventos de UI
    // ---------------------------------------------------------
    function bindControls() {
        document.getElementById('langToggle').addEventListener('click', function () {
            state.lang = state.lang === 'es' ? 'en' : 'es';
            this.setAttribute('aria-pressed', state.lang === 'en' ? 'true' : 'false');
            renderAll();
        });

        document.getElementById('userRoleSelect').addEventListener('change', function () {
            state.role = this.value;
        });

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
    function init() {
        initHistory();
        bindControls();
        renderAll();
        setInterval(tick, 3000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
