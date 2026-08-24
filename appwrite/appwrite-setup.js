/**
 * appwrite/appwrite-setup.js
 *
 * Standalone script to create all Appwrite collections for the Discord bot.
 *
 * Usage:
 *   node appwrite/appwrite-setup.js
 *
 * Required environment variables:
 *   APPWRITE_ENDPOINT    - e.g. https://fra.cloud.appwrite.io/v1
 *   APPWRITE_PROJECT_ID  - e.g. tutorslink
 *   APPWRITE_API_KEY     - Server API key with databases.write scope
 *   APPWRITE_DB_ID       - Database ID (default: tutorslink)
 */

import dotenv from 'dotenv';
dotenv.config();

import { Client, Databases, Permission, Role, AppwriteException } from 'node-appwrite';
import { DB_ID, COLLECTION_IDS } from './collection-ids.js';

const ENDPOINT   = process.env.APPWRITE_ENDPOINT   || 'https://fra.cloud.appwrite.io/v1';
const PROJECT_ID = process.env.APPWRITE_PROJECT_ID || 'tutorslink';
const API_KEY    = process.env.APPWRITE_API_KEY;

if (!API_KEY) {
  console.error('Missing required environment variable: APPWRITE_API_KEY');
  process.exit(1);
}

const client = new Client()
  .setEndpoint(ENDPOINT)
  .setProject(PROJECT_ID)
  .setKey(API_KEY);

const databases = new Databases(client);

const SHOW_STACK = process.env.APPWRITE_SETUP_SHOW_STACK === '1';

const NETWORK_ERROR_HINTS = {
  ENOTFOUND: 'DNS lookup failed. Check APPWRITE_ENDPOINT host and DNS/network settings.',
  EAI_AGAIN: 'Temporary DNS failure. Retry and verify DNS connectivity on this machine.',
  ECONNREFUSED: 'Connection refused. Endpoint reachable but service/port rejected the connection.',
  ECONNRESET: 'Connection reset by peer/network. Often a firewall/proxy/TLS interception issue.',
  ETIMEDOUT: 'Connection timed out. Check firewall/proxy rules and outbound HTTPS access.',
  ECONNABORTED: 'Connection aborted mid-request. Verify network stability/proxy behavior.',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS certificate could not be verified. Check CA chain/proxy interception.',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'Self-signed TLS cert detected. Use a trusted certificate/CA.',
  CERT_HAS_EXPIRED: 'TLS certificate has expired on the remote side or interception proxy.',
  ERR_INVALID_URL: 'Invalid APPWRITE_ENDPOINT URL format.',
  UND_ERR_INVALID_ARG: 'Undici request argument mismatch. Commonly caused by a Node/SDK incompatibility; use Node 20 LTS and update node-appwrite.',
};

function isObject(value) {
  return value !== null && typeof value === 'object';
}

function compactObject(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

function flattenErrorChain(error, maxDepth = 6) {
  const chain = [];
  let cur = error;
  let depth = 0;

  while (cur && depth < maxDepth) {
    if (isObject(cur)) {
      chain.push(cur);
      cur = cur.cause;
      depth += 1;
      continue;
    }
    chain.push({ message: String(cur) });
    break;
  }

  return chain;
}

function collectErrorCodes(chain) {
  const codes = [];
  for (const err of chain) {
    if (err?.code) codes.push(String(err.code));
    if (err?.errno) codes.push(String(err.errno));
  }
  return [...new Set(codes)];
}

function deriveHints(chain) {
  const hints = [];
  const codes = collectErrorCodes(chain);
  for (const code of codes) {
    if (NETWORK_ERROR_HINTS[code]) hints.push(`${code}: ${NETWORK_ERROR_HINTS[code]}`);
  }

  const joinedMessages = chain.map(e => String(e?.message || '')).join(' | ').toLowerCase();
  if (joinedMessages.includes('fetch failed')) {
    hints.push('fetch failed: low-level network/TLS details are usually in the nested cause fields below.');
  }
  if (joinedMessages.includes('unauthorized') || joinedMessages.includes('forbidden')) {
    hints.push('Auth issue: verify APPWRITE_PROJECT_ID and APPWRITE_API_KEY scopes (databases.read/write).');
  }
  if (joinedMessages.includes('not found')) {
    hints.push('Resource issue: verify APPWRITE_DB_ID exists and the project is correct.');
  }

  return [...new Set(hints)];
}

function formatErrorDetails(error, { includeStack = false } = {}) {
  const chain = flattenErrorChain(error);
  const lines = [];

  lines.push('Error diagnostics:');
  chain.forEach((err, idx) => {
    const part = idx === 0 ? 'root' : `cause#${idx}`;
    lines.push(`  - ${part}: ${err?.name || 'Error'}: ${err?.message || String(err)}`);

    const meta = compactObject({
      type: err?.type,
      code: err?.code,
      errno: err?.errno,
      statusCode: err?.statusCode,
      responseCode: err?.responseCode,
      syscall: err?.syscall,
      hostname: err?.hostname,
      address: err?.address,
      port: err?.port,
      path: err?.path,
    });
    if (Object.keys(meta).length > 0) {
      lines.push(`    meta: ${JSON.stringify(meta)}`);
    }

    // AppwriteException often carries useful response payload fields.
    if (isObject(err?.response)) {
      const responseMeta = compactObject({
        message: err.response.message,
        type: err.response.type,
        code: err.response.code,
        version: err.response.version,
      });
      if (Object.keys(responseMeta).length > 0) {
        lines.push(`    appwrite: ${JSON.stringify(responseMeta)}`);
      }
    }
  });

  const hints = deriveHints(chain);
  if (hints.length > 0) {
    lines.push('Hints:');
    hints.forEach(h => lines.push(`  - ${h}`));
  }

  if (includeStack && isObject(error) && typeof error.stack === 'string') {
    lines.push('Stack:');
    lines.push(error.stack);
  }

  return lines.join('\n');
}

function logDetailedError(prefix, error, { includeStack = SHOW_STACK } = {}) {
  console.error(`${prefix}\n${formatErrorDetails(error, { includeStack })}`);
}

function maskSecret(secret) {
  if (!secret) return '(missing)';
  if (secret.length <= 8) return '*'.repeat(secret.length);
  return `${secret.slice(0, 4)}...${secret.slice(-4)} (len=${secret.length})`;
}

function validateEnvironment() {
  const issues = [];

  try {
    const url = new URL(ENDPOINT);
    if (!['https:', 'http:'].includes(url.protocol)) {
      issues.push(`APPWRITE_ENDPOINT protocol must be http/https, got ${url.protocol}`);
    }
    if (!url.hostname) {
      issues.push('APPWRITE_ENDPOINT is missing a hostname.');
    }
  } catch {
    issues.push(`APPWRITE_ENDPOINT is not a valid URL: ${ENDPOINT}`);
  }

  if (!PROJECT_ID || !String(PROJECT_ID).trim()) {
    issues.push('APPWRITE_PROJECT_ID is missing or empty.');
  }
  if (!DB_ID || !String(DB_ID).trim()) {
    issues.push('APPWRITE_DB_ID is missing or empty.');
  }
  if (!API_KEY || !String(API_KEY).trim()) {
    issues.push('APPWRITE_API_KEY is missing or empty.');
  }

  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (Number.isFinite(nodeMajor) && nodeMajor < 18) {
    issues.push(`Node.js ${process.versions.node} detected. Node 18+ is required (Node 20 LTS recommended).`);
  }

  return issues;
}

async function preflightNetworkCheck() {
  const healthUrl = `${String(ENDPOINT).replace(/\/$/, '')}/health/version`;
  try {
    const res = await fetch(healthUrl, { method: 'GET' });
    if (!res.ok) {
      throw new Error(`Health check failed with HTTP ${res.status} ${res.statusText}`);
    }
    const body = await res.text();
    console.log(`   Health:     OK (${body.trim() || 'empty response'})`);
  } catch (error) {
    logDetailedError(`   Health check failed for ${healthUrl}`, error, { includeStack: false });
    throw new Error('Preflight network check failed. Aborting setup early.');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a collection, skipping if it already exists (HTTP 409).
 */
async function createCollection(collectionId, name, permissions = []) {
  try {
    await databases.createCollection(DB_ID, collectionId, name, permissions);
    console.log(`  ✅ Created collection: ${collectionId}`);
    return true;
  } catch (e) {
    if (e instanceof AppwriteException && e.code === 409) {
      console.log(`  ⏭  Skipped (already exists): ${collectionId}`);
      return false;
    }
    throw e;
  }
}

/**
 * Create a longtext attribute, skipping if the collection already had it.
 */
async function createLongtextAttr(collectionId, key, required = false) {
  try {
    await databases.createLongtextAttribute(DB_ID, collectionId, key, required);
    console.log(`    + attribute: ${key} (longtext)`);
  } catch (e) {
    if (e instanceof AppwriteException && e.code === 409) {
      // attribute already exists, skip silently
    } else {
      console.warn(`    ⚠ Failed to create attribute ${key} on ${collectionId}`);
      console.warn(formatErrorDetails(e));
    }
  }
}

/**
 * Create a string attribute, skipping if already exists.
 */
async function createStringAttr(collectionId, key, size = 512, required = false) {
  try {
    await databases.createStringAttribute(DB_ID, collectionId, key, size, required);
    console.log(`    + attribute: ${key} (string, size=${size})`);
  } catch (e) {
    if (e instanceof AppwriteException && e.code === 409) {
      // already exists, skip silently
    } else {
      console.warn(`    ⚠ Failed to create attribute ${key} on ${collectionId}`);
      console.warn(formatErrorDetails(e));
    }
  }
}

/**
 * Create an integer attribute, skipping if already exists.
 */
async function createIntegerAttr(collectionId, key, required = false) {
  try {
    await databases.createIntegerAttribute(DB_ID, collectionId, key, required);
    console.log(`    + attribute: ${key} (integer)`);
  } catch (e) {
    if (e instanceof AppwriteException && e.code === 409) {
      // already exists, skip silently
    } else {
      console.warn(`    ⚠ Failed to create attribute ${key} on ${collectionId}`);
      console.warn(formatErrorDetails(e));
    }
  }
}

/**
 * Wait for a collection's attributes to finish processing (Appwrite builds
 * attributes asynchronously; we need to wait before adding documents).
 */
async function waitForAttributes(collectionId, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const col = await databases.getCollection(DB_ID, collectionId);
    const attrs = col.attributes || [];
    const allReady = attrs.every(a => a.status === 'available');
    if (allReady && attrs.length > 0) return;
    await new Promise(r => setTimeout(r, 1000));
  }
}

// ---------------------------------------------------------------------------
// Public permissions (any user can read, only server key can write)
// ---------------------------------------------------------------------------
const PUBLIC_READ_PERMS = [
  Permission.read(Role.any()),
];

const SERVER_ONLY_PERMS = [];   // rely on API-key-level access; no public read

// ---------------------------------------------------------------------------
// Collection definitions
// ---------------------------------------------------------------------------

/**
 * Each collection uses a `data` longtext field to store the full JSON payload.
 * Synced collections also expose a lightweight `entityId` string for
 * cross-app lookups (e.g. the website can filter tutorProfiles by tutorId).
 */
const COLLECTIONS = [
  // ── Synced with Website ──────────────────────────────────────────────────

  {
    id: COLLECTION_IDS.subjects,
    name: 'Discord Subjects',
    permissions: PUBLIC_READ_PERMS,
    // Single document (id="all") holding a JSON array of subject strings.
    attrs: async (cid) => {
      await createLongtextAttr(cid, 'data', true);
    },
  },

  {
    id: COLLECTION_IDS.subjectLevels,
    name: 'Discord Subject Levels',
    permissions: PUBLIC_READ_PERMS,
    // Single document (id="all"): { subjectName: levelKey, … }
    attrs: async (cid) => {
      await createLongtextAttr(cid, 'data', true);
    },
  },

  {
    id: COLLECTION_IDS.subjectTutors,
    name: 'Discord Subject Tutors',
    permissions: PUBLIC_READ_PERMS,
    // Single document (id="all"): { subjectName: [tutorId, …], … }
    attrs: async (cid) => {
      await createLongtextAttr(cid, 'data', true);
    },
  },

  {
    id: COLLECTION_IDS.tutorProfiles,
    name: 'Discord Tutor Profiles',
    permissions: PUBLIC_READ_PERMS,
    // One document per tutor; documentId = tutorId.
    // data: JSON.stringify({ addedAt, students, reviews, rating, username, … })
    attrs: async (cid) => {
      await createStringAttr(cid, 'entityId', 64, true);   // Discord tutorId
      await createLongtextAttr(cid, 'data', true);
    },
  },

  {
    id: COLLECTION_IDS.studentAssignments,
    name: 'Discord Student Assignments',
    permissions: PUBLIC_READ_PERMS,
    // One document per student; documentId = studentId.
    // data: JSON.stringify({ tutorId, subject, assignedAt, … })
    attrs: async (cid) => {
      await createStringAttr(cid, 'entityId', 64, true);   // Discord studentId
      await createLongtextAttr(cid, 'data', true);
    },
  },

  {
    id: COLLECTION_IDS.pendingReviews,
    name: 'Discord Pending Reviews',
    permissions: PUBLIC_READ_PERMS,
    // One document per review; documentId = review.id.
    // data: JSON.stringify({ id, studentId, tutorId, subject, rating, … })
    attrs: async (cid) => {
      await createStringAttr(cid, 'entityId', 64, true);   // review id
      await createLongtextAttr(cid, 'data', true);
    },
  },

  {
    id: COLLECTION_IDS.reviewConfig,
    name: 'Discord Review Config',
    permissions: PUBLIC_READ_PERMS,
    // Single document (id="config"): { delaySeconds, … }
    attrs: async (cid) => {
      await createLongtextAttr(cid, 'data', true);
    },
  },

  {
    id: COLLECTION_IDS.modmail,
    name: 'Discord Modmail',
    permissions: PUBLIC_READ_PERMS,
    // Single document (id="all"): full modmail object serialized as JSON.
    attrs: async (cid) => {
      await createLongtextAttr(cid, 'data', true);
    },
  },

  {
    id: COLLECTION_IDS.initMessage,
    name: 'Discord Init Message',
    permissions: PUBLIC_READ_PERMS,
    // Single document (id="config"): { message: "…template…" }
    attrs: async (cid) => {
      await createLongtextAttr(cid, 'data', true);
    },
  },

  {
    id: COLLECTION_IDS.nextTicketId,
    name: 'Discord Next Ticket Id',
    permissions: SERVER_ONLY_PERMS,
    // Single document (id="counter"): 123
    attrs: async (cid) => {
      await createLongtextAttr(cid, 'data', true);
    },
  },

  {
    id: COLLECTION_IDS.defaultEmbedColor,
    name: 'Discord Default Embed Color',
    permissions: SERVER_ONLY_PERMS,
    // Single document (id="config"): "#5865F2" | null
    attrs: async (cid) => {
      await createLongtextAttr(cid, 'data', true);
    },
  },

  // ── Discord-Only ─────────────────────────────────────────────────────────

  {
    id: COLLECTION_IDS.cooldowns,
    name: 'Discord Cooldowns',
    permissions: SERVER_ONLY_PERMS,
    // One document per user; documentId = userId.
    // data: JSON.stringify({ lastCooldown: timestamp })
    attrs: async (cid) => {
      await createStringAttr(cid, 'entityId', 64, true);
      await createLongtextAttr(cid, 'data', true);
    },
  },

  {
    id: COLLECTION_IDS.bumpLeaderboard,
    name: 'Discord Bump Leaderboard',
    permissions: SERVER_ONLY_PERMS,
    // One document per user; documentId = userId.
    // data: JSON.stringify({ count, lastBump })
    attrs: async (cid) => {
      await createStringAttr(cid, 'entityId', 64, true);
      await createLongtextAttr(cid, 'data', true);
    },
  },

  {
    id: COLLECTION_IDS.sticky,
    name: 'Discord Sticky',
    permissions: SERVER_ONLY_PERMS,
    // Single document (id="config"): { title, body, color, messageId } | null
    attrs: async (cid) => {
      await createLongtextAttr(cid, 'data', true);
    },
  },

  {
    id: COLLECTION_IDS.aiChannel,
    name: 'Discord AI Channel',
    permissions: SERVER_ONLY_PERMS,
    // Single document (id="config"): channel ID string | null
    attrs: async (cid) => {
      await createLongtextAttr(cid, 'data', true);
    },
  },

  {
    id: COLLECTION_IDS.keywords,
    name: 'Discord Keywords',
    permissions: SERVER_ONLY_PERMS,
    // Single document (id="all"): keyword automation array
    attrs: async (cid) => {
      await createLongtextAttr(cid, 'data', true);
    },
  },

  {
    id: COLLECTION_IDS.tickets,
    name: 'Discord Tickets',
    permissions: SERVER_ONLY_PERMS,
    // One document per ticket; documentId = ticketId.
    // data: JSON.stringify({ studentId, subject, channelId, … })
    attrs: async (cid) => {
      await createStringAttr(cid, 'entityId', 64, true);
      await createLongtextAttr(cid, 'data', true);
    },
  },

  {
    id: COLLECTION_IDS.tempTutorAdd,
    name: 'Discord Temp Tutor Add',
    permissions: SERVER_ONLY_PERMS,
    // One document per session; documentId = userId.
    // data: JSON.stringify({ subject, userid, level })
    attrs: async (cid) => {
      await createStringAttr(cid, 'entityId', 64, true);
      await createLongtextAttr(cid, 'data', true);
    },
  },

  {
    id: COLLECTION_IDS.tempTutorRemove,
    name: 'Discord Temp Tutor Remove',
    permissions: SERVER_ONLY_PERMS,
    // One document per session; documentId = userId.
    // data: JSON.stringify({ subject, userid })
    attrs: async (cid) => {
      await createStringAttr(cid, 'entityId', 64, true);
      await createLongtextAttr(cid, 'data', true);
    },
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n🚀 Appwrite Collection Setup`);
  console.log(`   Runtime:    node ${process.versions.node}`);
  console.log(`   Endpoint:   ${ENDPOINT}`);
  console.log(`   Project:    ${PROJECT_ID}`);
  console.log(`   Database:   ${DB_ID}`);
  console.log(`   API key:    ${maskSecret(API_KEY)}`);
  console.log(`   Collections to create: ${COLLECTIONS.length}\n`);

  const envIssues = validateEnvironment();
  if (envIssues.length > 0) {
    console.error('❌ Environment validation failed:');
    for (const issue of envIssues) {
      console.error(`   - ${issue}`);
    }
    process.exit(1);
  }

  await preflightNetworkCheck();

  let created = 0;
  let skipped = 0;
  let errors  = 0;

  for (const col of COLLECTIONS) {
    console.log(`\n📁 ${col.name} (${col.id})`);
    try {
      const wasCreated = await createCollection(col.id, col.name, col.permissions);
      if (wasCreated) {
        created++;
      } else {
        skipped++;
      }
      // Always ensure attributes are present regardless of whether the
      // collection is new or already existed. The create*Attr helpers
      // silently skip attributes that are already defined (HTTP 409), so
      // this is safe to re-run and will pick up any schema changes.
      if (col.attrs) {
        await col.attrs(col.id);
        await waitForAttributes(col.id);
      }
    } catch (e) {
      errors++;
      logDetailedError(`  ❌ Error creating ${col.id}`, e, { includeStack: false });
    }
  }

  console.log(`\n✨ Done!`);
  console.log(`   Created: ${created}`);
  console.log(`   Skipped: ${skipped}`);
  console.log(`   Errors:  ${errors}`);

  if (errors > 0) process.exit(1);
}

main().catch(e => {
  logDetailedError('Fatal error in appwrite-setup.js', e, { includeStack: true });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logDetailedError('Unhandled promise rejection', reason, { includeStack: true });
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  logDetailedError('Uncaught exception', error, { includeStack: true });
  process.exit(1);
});
