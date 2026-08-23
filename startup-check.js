/**
 * startup-check.js
 *
 * Early startup validation for hosting environments.
 * - Detects a broken .env path (directory instead of file)
 * - Prints clear guidance for environment variable setup
 * - Warns (never crashes) about optional env vars for Appwrite split and AI
 */

import fs from 'fs';
import path from 'path';

const ENV_PATH = path.resolve(process.cwd(), '.env');

export function runStartupPreflight() {
  try {
    if (fs.existsSync(ENV_PATH)) {
      const stat = fs.statSync(ENV_PATH);
      if (stat.isDirectory()) {
        console.error('[Startup] Fatal: .env is a directory, not a file.');
        console.error('[Startup] This breaks npm/package resolution in some hosts.');
        console.error('[Startup] Fix: remove the .env directory and set variables in your host environment panel.');
        process.exit(1);
      }
    }
  } catch (e) {
    console.warn('[Startup] Preflight check encountered an error:', e.message);
  }

  // -------------------------------------------------------------------------
  // Inform about database env var split
  // -------------------------------------------------------------------------
  const hasBotDbId     = !!(process.env.APPWRITE_BOT_DB_ID);
  const hasLegacyDbId  = !!(process.env.APPWRITE_DB_ID);

  if (!hasBotDbId && !hasLegacyDbId) {
    console.warn('[Startup] Neither APPWRITE_BOT_DB_ID nor APPWRITE_DB_ID is set. Appwrite persistence is disabled; running in local JSON mode.');
  } else if (!hasBotDbId && hasLegacyDbId) {
    console.warn('[Startup] APPWRITE_DB_ID detected (legacy). Rename to APPWRITE_BOT_DB_ID for the new dual-database setup. Backward-compat fallback is active.');
  } else {
    console.log('[BotDB] APPWRITE_BOT_DB_ID configured.');
  }

  // -------------------------------------------------------------------------
  // Website (read-only) database — optional, warn if partially configured
  // -------------------------------------------------------------------------
  const websiteVars = {
    APPWRITE_WEBSITE_ENDPOINT:   process.env.APPWRITE_WEBSITE_ENDPOINT,
    APPWRITE_WEBSITE_PROJECT_ID: process.env.APPWRITE_WEBSITE_PROJECT_ID,
    APPWRITE_WEBSITE_API_KEY:    process.env.APPWRITE_WEBSITE_API_KEY,
    APPWRITE_WEBSITE_DB_ID:      process.env.APPWRITE_WEBSITE_DB_ID,
  };
  const presentWebsite = Object.values(websiteVars).filter(Boolean).length;
  if (presentWebsite === 0) {
    console.warn('[Startup] Website DB env vars not set (APPWRITE_WEBSITE_ENDPOINT / _PROJECT_ID / _API_KEY / _DB_ID). Alvey AI will fall back to bot DB data for context.');
  } else if (presentWebsite < 4) {
    const missing = Object.entries(websiteVars).filter(([, v]) => !v).map(([k]) => k);
    console.warn(`[Startup] Website DB partially configured. Missing: ${missing.join(', ')}. Alvey AI context will be degraded.`);
  } else {
    console.log('[WebsiteDB] Website DB env vars present. Read-only context for Alvey will be available.');
  }

  // -------------------------------------------------------------------------
  // AI assistant — optional, warn if missing
  // -------------------------------------------------------------------------
  if (!process.env.OPENAI_API_KEY) {
    console.warn('[Startup] OPENAI_API_KEY is not set. Alvey AI assistant will be disabled.');
  } else {
    console.log('[Alvey] OPENAI_API_KEY detected. AI assistant will initialise.');
  }

  if (!process.env.AI_CHANNEL_ID) {
    console.warn('[Startup] AI_CHANNEL_ID is not set. Alvey will only respond in a channel configured via /aichannel.');
  }
}
