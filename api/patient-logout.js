export default function handler(req, res) {
    res.setHeader('Set-Cookie', 'medstation_patient=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
    return res.status(204).end();
}
