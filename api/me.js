// ================================================================
// Proxy de identidad: dado un token de sesión, devuelve el rol
// (authority) y el customerId del usuario logueado.
// ================================================================
export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');

    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!token) {
        res.status(401).json({ error: 'Falta token' });
        return;
    }

    try {
        const tbRes = await fetch(`${process.env.TB_BASE_URL}/api/auth/user`, {
            headers: { 'X-Authorization': `Bearer ${token}` }
        });

        if (!tbRes.ok) {
            res.status(tbRes.status).json({ error: 'Token inválido o expirado' });
            return;
        }

        const user = await tbRes.json();
        // ThingsBoard usa este UUID "nulo" cuando el usuario NO tiene customer
        // (caso del Tenant Admin, que ve todo).
        const NULL_CUSTOMER = '13814000-1dd2-11b2-8080-808080808080';
        const customerId = user.customerId && user.customerId.id !== NULL_CUSTOMER
            ? user.customerId.id
            : null;

        res.status(200).json({
            authority: user.authority,
            customerId,
            email: user.email
        });
    } catch (err) {
        console.error(err);
        res.status(502).json({ error: 'No se pudo conectar con ThingsBoard.' });
    }
}
