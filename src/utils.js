import { chownSync } from 'fs';
import { PUID, PGID } from './config.js';

export function fixOwnership(filePath) {
  if (PUID !== null || PGID !== null) {
    chownSync(filePath, PUID ?? -1, PGID ?? -1);
  }
}

export function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, '')  // Remove illegal chars
    .replace(/\s+/g, ' ')           // Collapse whitespace
    .trim()
    .substring(0, 200);             // Cap length
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}