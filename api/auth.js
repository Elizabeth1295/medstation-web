// ================================================================
// Proxy de login: recibe usuario/contraseña del formulario y
// autentica contra ThingsBoard. Nunca expone TB_BASE_URL al navegador.
// ================================================================
export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');

    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Método no permitido' });
        return;
    }

    const { username, password } = req.body || {};
    if (!username || !password) {
        res.status(400).json({ error: 'Falta usuario o contraseña' });
        return;
    }

    try {
        const tbRes = await fetch(`${process.env.TB_BASE_URL}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        if (!tbRes.ok) {
            res.status(401).json({ error: 'Credenciales inválidas' });
            return;
        }

        const json = await tbRes.json();
        res.status(200).json({ token: json.token, refreshToken: json.refreshToken });
    } catch (err) {
        console.error(err);
        res.status(502).json({ error: 'No se pudo conectar con ThingsBoard.' });
    }
}
