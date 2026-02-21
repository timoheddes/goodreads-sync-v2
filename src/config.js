// Database path
export const DB_PATH = process.env.DB_PATH || '/app/data/books.db';

// Cron schedule
export const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 * * * *';

// Anna's Archive API key
export const AA_API_KEY = process.env.AA_API_KEY;

// FlareSolverr URL
export const FLARESOLVERR_URL = process.env.FLARE_URL || 'http://flaresolverr:8191/v1';

// Search limits
export const MAX_ATTEMPTS = 5;
export const QUEUE_COOLDOWN_MS = 5000; // 5 seconds between queue items

// Download limits
export const MAX_DOWNLOADS_PER_USER_PER_DAY = parseInt(process.env.MAX_DOWNLOADS_PER_USER_PER_DAY || '10', 10);
export const MAX_DOWNLOADS_PER_DAY = parseInt(process.env.MAX_DOWNLOADS_PER_DAY || '50', 10);

// SMTP configuration
export const SMTP_HOST = process.env.SMTP_HOST || 'localhost';
export const SMTP_PORT = parseInt(process.env.SMTP_PORT || '25', 10);
export const SMTP_FROM = process.env.SMTP_FROM || '';

// File ownership (for NAS/Synology compatibility)
export const PUID = process.env.PUID ? parseInt(process.env.PUID, 10) : null;
export const PGID = process.env.PGID ? parseInt(process.env.PGID, 10) : null;

// Anna's Archive domains
export const AA_DOMAINS = [
  'annas-archive.li',
  'annas-archive.gl',
];