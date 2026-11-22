/**
 * Minimal request fence for the plugin's own HTTP routes.
 *
 * The remote-mic routes only serve the local panel, so they accept same-origin
 * loopback requests and refuse anything a cross-site page could send. The DSH
 * host may also check the request; this fence is deliberately independent so a
 * host change cannot silently make the routes fail open.
 */

/** Extra hostnames to trust, comma separated, for a proxied deployment. */
const TRUSTED_HOSTS_ENV = 'DSH_STT_HANT_TRUSTED_HOSTS'

/** @param {string} hostname lower-cased hostname without brackets. */
export function isLoopbackHostname(hostname) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (host === '') return false
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1') return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (match === null) return false
  if (Number(match[1]) !== 127) return false
  return [match[2], match[3], match[4]].every((part) => Number(part) <= 255)
}

/** @returns extra trusted hostnames from the environment. */
export function trustedHostsFromEnv(env = globalThis.process?.env) {
  return String(env?.[TRUSTED_HOSTS_ENV] ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '')
}

/**
 * Decide whether one request must be rejected before a handler sees it.
 * @param {import('node:http').IncomingMessage} req
 * @param {{ trustedHosts?: string[] }} [options]
 * @returns {number | null} HTTP status to answer, or null to allow.
 */
export function selfRejection(req, options = {}) {
  const headers = req?.headers ?? {}
  const trustedHosts = options.trustedHosts ?? trustedHostsFromEnv()

  const rawHost = String(headers.host ?? '')
  let hostUrl
  try {
    hostUrl = new URL(`http://${rawHost}`)
  } catch {
    return 403
  }
  const hostname = hostUrl.hostname.toLowerCase()
  if (!isLoopbackHostname(hostname) && !trustedHosts.includes(hostname)) return 403

  const site = String(headers['sec-fetch-site'] ?? '').toLowerCase()
  if (site === 'cross-site' || site === 'same-site') return 403

  const origin = headers.origin
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    let originUrl
    try {
      originUrl = new URL(origin)
    } catch {
      return 403
    }
    if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') return 403
    if (originUrl.host !== hostUrl.host) return 403
  }
  return null
}
