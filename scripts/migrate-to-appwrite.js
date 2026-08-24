/**
 * scripts/migrate-to-appwrite.js
 *
 * One-time migration script: reads all data from data.json and uploads it to
 * Appwrite collections. Skips documents that already exist so it is safe to
 * re-run. Provide --force to overwrite existing documents.
 *
 * Usage:
 *   node scripts/migrate-to-appwrite.js [--force]
 *
 * Required environment variables (same as the main bot):
 *   APPWRITE_ENDPOINT    - e.g. https://fra.cloud.appwrite.io/v1
 *   APPWRITE_PROJECT_ID  - e.g. tutorslink
 *   APPWRITE_API_KEY     - Server API key with databases.write scope
 *   APPWRITE_DB_ID       - Database ID (default: tutorslink)
 *
 * Run the collection setup script first:
 *   node appwrite/appwrite-setup.js
 */

import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client, Databases, AppwriteException } from 'node-appwrite';
import { DB_ID, COLLECTION_IDS } from '../appwrite/collection-ids.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, '..', 'data.json');

// ---------------------------------------------------------------------------
// Environment / client setup
// ---------------------------------------------------------------------------

const ENDPOINT   = process.env.APPWRITE_ENDPOINT   || 'https://fra.cloud.appwrite.io/v1';
const PROJECT_ID = process.env.APPWRITE_PROJECT_ID || 'tutorslink';
const API_KEY    = process.env.APPWRITE_API_KEY;

if (!API_KEY) {
  console.error('❌ Missing required environment variable: APPWRITE_API_KEY');
  process.exit(1);
}

const client = new Client()
  .setEndpoint(ENDPOINT)
  .setProject(PROJECT_ID)
  .setKey(API_KEY);

const databases = new Databases(client);

const FORCE = process.argv.includes('--force');

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

let totalDocs  = 0;
let created    = 0;
let skipped    = 0;
let errors     = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Upsert a document; if --force is set always overwrites, otherwise skips existing. */
async function upsertDoc(collectionId, documentId, payload) {
  totalDocs++;
  try {
    if (FORCE) {
      await databases.upsertDocument(DB_ID, collectionId, documentId, payload);
      created++;
      return;
    }
    // Try to create; if it already exists (409), skip.
    try {
      await databases.createDocument(DB_ID, collectionId, documentId, payload);
      created++;
    } catch (e) {
      if (e instanceof AppwriteException && e.code === 409) {
        skipped++;
      } else {
        throw e;
      }
    }
  } catch (e) {
    errors++;
    console.warn(`  ⚠ Error upserting ${collectionId}/${documentId}: ${e.message}`);
  }
}

/** Log progress bar. */
function progress(label, done, total) {
  const pct  = total > 0 ? Math.round((done / total) * 100) : 100;
  const bar  = '█'.repeat(Math.floor(pct / 5)).padEnd(20, '░');
  process.stdout.write(`\r  ${label}: [${bar}] ${pct}% (${done}/${total})`);
}

// ---------------------------------------------------------------------------
// Collection migrators
// ---------------------------------------------------------------------------

async function migrateSingleDoc(label, collectionId, docId, value) {
  console.log(`\n📋 ${label}`);
  if (value === undefined || value === null) {
    console.log('   (empty – skipping)');
    return;
  }
  await upsertDoc(collectionId, docId, { data: JSON.stringify(value) });
  console.log(`   → 1 document`);
}

async function migrateMap(label, collectionId, mapObj) {
  console.log(`\n📦 ${label}`);
  if (!mapObj || typeof mapObj !== 'object') {
    console.log('   (empty – skipping)');
    return;
  }
  const entries = Object.entries(mapObj);
  if (entries.length === 0) {
    console.log('   (empty – skipping)');
    return;
  }
  let done = 0;
  for (const [rawKey, value] of entries) {
    // Strip Discord mention format: <@123456789> → 123456789 (document IDs
    // cannot contain special chars like <, @, >).
    const mentionMatch = rawKey.match(/^<@!?(\d+)>$/);
    const entityId = mentionMatch ? mentionMatch[1] : rawKey;
    // When the key was a mention, embed the original mention string in the
    // stored data so the frontend can display clickable @-mentions.
    const dataPayload = mentionMatch
      ? { id: rawKey, ...value }
      : value;
    await upsertDoc(collectionId, entityId, {
      entityId,
      data: JSON.stringify(dataPayload),
    });
    done++;
    progress(label, done, entries.length);
  }
  console.log(`\n   → ${entries.length} documents`);
}

async function migrateArray(label, collectionId, arr) {
  console.log(`\n📋 ${label}`);
  if (!Array.isArray(arr) || arr.length === 0) {
    console.log('   (empty – skipping)');
    return;
  }
  let done = 0;
  for (const item of arr) {
    if (!item || !item.id) {
      console.warn(`   ⚠ Skipping array item without .id:`, JSON.stringify(item).slice(0, 80));
      continue;
    }
    await upsertDoc(collectionId, String(item.id), {
      entityId: String(item.id),
      data: JSON.stringify(item),
    });
    done++;
    progress(label, done, arr.length);
  }
  console.log(`\n   → ${arr.length} documents`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('\n🚀 Appwrite Migration: data.json → Appwrite');
  console.log(`   Endpoint:   ${ENDPOINT}`);
  console.log(`   Project:    ${PROJECT_ID}`);
  console.log(`   Database:   ${DB_ID}`);
  console.log(`   Mode:       ${FORCE ? 'FORCE (overwrite existing)' : 'safe (skip existing)'}`);

  // Load data.json
  if (!fs.existsSync(DATA_FILE)) {
    console.error(`\n❌ data.json not found at ${DATA_FILE}`);
    process.exit(1);
  }
  let db;
  try {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error(`\n❌ Failed to parse data.json: ${e.message}`);
    process.exit(1);
  }
  console.log(`\n✅ Loaded data.json (${(JSON.stringify(db).length / 1024).toFixed(1)} KB)`);

  // ── Synced with Website ──────────────────────────────────────────────────

  await migrateSingleDoc('subjects', COLLECTION_IDS.subjects, 'all', db.subjects);

  await migrateSingleDoc('subjectLevels', COLLECTION_IDS.subjectLevels, 'all', db.subjectLevels);

  await migrateSingleDoc('subjectTutors', COLLECTION_IDS.subjectTutors, 'all', db.subjectTutors);

  await migrateMap('tutorProfiles', COLLECTION_IDS.tutorProfiles, db.tutorProfiles);

  await migrateMap('studentAssignments', COLLECTION_IDS.studentAssignments, db.studentAssignments);

  await migrateArray('pendingReviews', COLLECTION_IDS.pendingReviews, db.pendingReviews);

  await migrateSingleDoc('reviewConfig', COLLECTION_IDS.reviewConfig, 'config', db.reviewConfig);

  // Modmail – stored as a single document under "all".
  // Merge _modmail_helpers into the modmail payload so everything is in one place.
  const modmailPayload = {
    ...(db.modmail && typeof db.modmail === 'object' ? db.modmail : {}),
    _helpers: db._modmail_helpers || {},
  };
  await migrateSingleDoc('modmail', COLLECTION_IDS.modmail, 'all', modmailPayload);

  await migrateSingleDoc('initMessage', COLLECTION_IDS.initMessage, 'config',
    { message: db.initMessage || '' });

  await migrateSingleDoc('nextTicketId', COLLECTION_IDS.nextTicketId, 'counter', db.nextTicketId);

  await migrateSingleDoc('defaultEmbedColor', COLLECTION_IDS.defaultEmbedColor, 'config', db.defaultEmbedColor);

  // ── Discord-Only ─────────────────────────────────────────────────────────

  await migrateMap('cooldowns', COLLECTION_IDS.cooldowns, db.cooldowns);

  await migrateMap('bumpLeaderboard', COLLECTION_IDS.bumpLeaderboard, db.bumpLeaderboard);

  await migrateSingleDoc('sticky', COLLECTION_IDS.sticky, 'config', db.sticky ?? null);

  await migrateMap('tickets', COLLECTION_IDS.tickets, db.tickets);

  await migrateMap('_tempTutorAdd', COLLECTION_IDS.tempTutorAdd, db._tempTutorAdd);

  await migrateMap('_tempTutorRemove', COLLECTION_IDS.tempTutorRemove, db._tempTutorRemove);

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log('\n');
  console.log('═══════════════════════════════════════');
  console.log('  Migration Complete');
  console.log('═══════════════════════════════════════');
  console.log(`  Total documents processed : ${totalDocs}`);
  console.log(`  Created                   : ${created}`);
  console.log(`  Skipped (already existed) : ${skipped}`);
  console.log(`  Errors                    : ${errors}`);
  console.log('═══════════════════════════════════════\n');

  if (errors > 0) {
    console.warn('⚠ Some documents failed to migrate. Re-run the script to retry.');
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
