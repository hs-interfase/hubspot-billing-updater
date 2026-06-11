// api/invoice-editor/auth.js
// Basic Auth para el Editor de Facturas
// Lee APP_EDITOR_USER y APP_EDITOR_PASSWORD desde .env

export function invoiceEditorAuth(req, res, next) {
  // Fail-closed: si no hay credenciales configuradas, no dejamos entrar a nadie.
  if (!process.env.APP_EDITOR_USER || !process.env.APP_EDITOR_PASSWORD) {
    console.error('[auth] APP_EDITOR_USER/APP_EDITOR_PASSWORD no configuradas — rechazando acceso')
    return res.status(503).send('Autenticación no configurada en el servidor.')
  }

  const authHeader = req.headers['authorization']

  if (!authHeader?.startsWith('Basic ')) {
    return res.status(401)
      .set('WWW-Authenticate', 'Basic realm="Editor de Facturas"')
      .send('Acceso denegado.')
  }

  const decoded = Buffer.from(authHeader.slice('Basic '.length), 'base64').toString('utf-8')
  const colonIdx = decoded.indexOf(':')
  const user = decoded.slice(0, colonIdx)
  const password = decoded.slice(colonIdx + 1)

  if (
    user === process.env.APP_EDITOR_USER &&
    password === process.env.APP_EDITOR_PASSWORD
  ) {
    return next()
  }

  return res.status(401)
    .set('WWW-Authenticate', 'Basic realm="Editor de Facturas"')
    .send('Usuario o contraseña incorrectos.')
}
