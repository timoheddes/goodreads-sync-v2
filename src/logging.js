export function timestamp() {
  // Use TZ env var (e.g. Europe/Amsterdam) for local time; falls back to UTC
  return new Date().toLocaleString('sv-SE', {
    timeZone: process.env.TZ || 'UTC',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

export function log(msg) {
  console.log(`[${timestamp()}] ${msg}`);
}

export function logError(msg, err) {
  console.error(`[${timestamp()}] ❌ ${msg}`, err ? err.message : '');
  if (err && err.stack) {
    console.error(err.stack);
  }
}

export function logWarn(msg) {
  console.warn(`[${timestamp()}] ⚠️  ${msg}`);
}