/**
 * appwrite/appwrite-client.js
 *
 * Bot-only Appwrite integration module for the Discord bot.
 *
 * Uses APPWRITE_BOT_DB_ID (with APPWRITE_DB_ID as backward-compat fallback).
 *
 * Provides:
 *   - Lazy-initialized Appwrite SDK client
 *   - syncDB(db)  – write current in-memory db to Appwrite (all collections)
 *   - loadDB()    – read all collections from Appwrite; returns partial db object
 *   - Per-collection helpers for more granular reads/writes
 *
 * This module ONLY writes to the bot database.
 * For website data (read-only), use appwrite-website-reader.js.
 *
 * All functions are designed to fail gracefully: errors are logged with
 * console.warn and the caller receives null / undefined so the bot can
 * fall back to its local data.json without crashing.
 */

import { Client, Databases, ID, Query, AppwriteException } from 'node-appwrite';
import { DB_ID, COLLECTION_IDS } from './collection-ids.js';

// ---------------------------------------------------------------------------
// Client initialisation
// ---------------------------------------------------------------------------

const ENDPOINT   = process.env.APPWRITE_ENDPOINT;
const PROJECT_ID = process.env.APPWRITE_PROJECT_ID;
const API_KEY    = process.env.APPWRITE_API_KEY;

let _databases = null;

function isRetryableError(err) {
  const msg = String(err?.message || '').toLowerCase();
  const code = Number(err?.code);
  if ([408, 425, 429, 500, 502, 503, 504].includes(code)) return true;
  return (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('network')
  );
}

async function withRetry(op, label, retries = 3) {
  let attempt = 0;
  let lastErr = null;
  while (attempt < retries) {
    attempt += 1;
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (!isRetryableError(err) || attempt >= retries) break;
      const delayMs = 250 * Math.pow(2, attempt - 1);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr || new Error(`${label} failed`);
}

function getDB() {
  if (_databases) return _databases;
  if (!ENDPOINT || !PROJECT_ID || !API_KEY) {
    return null; // Appwrite not configured → skip silently
  }
  const client = new Client()
    .setEndpoint(ENDPOINT)
    .setProject(PROJECT_ID)
    .setKey(API_KEY);
  _databases = new Databases(client);
  return _databases;
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

/**
 * Upsert a document (create if new, update if exists).
 * Returns the saved document or null on error.
 */
async function upsertDoc(collectionId, documentId, payload) {
  const db = getDB();
  if (!db) return null;
  try {
    return await withRetry(
      () => db.upsertDocument(DB_ID, collectionId, documentId, payload),
      `upsertDoc ${collectionId}/${documentId}`
    );
  } catch (e) {
    console.warn(`[Appwrite] upsertDoc failed (${collectionId}/${documentId}): ${e.message}`);
    return null;
  }
}

/**
 * Fetch a single document. Returns null if not found or on error.
 */
async function getDoc(collectionId, documentId) {
  const db = getDB();
  if (!db) return null;
  try {
    return await withRetry(
      () => db.getDocument(DB_ID, collectionId, documentId),
      `getDoc ${collectionId}/${documentId}`
    );
  } catch (e) {
    if (e instanceof AppwriteException && e.code === 404) return null;
    console.warn(`[Appwrite] getDoc failed (${collectionId}/${documentId}): ${e.message}`);
    return null;
  }
}

/**
 * List all documents in a collection (handles pagination).
 * Returns array of documents or [] on error.
 */
async function listDocs(collectionId, queries = []) {
  const db = getDB();
  if (!db) return [];
  try {
    const PAGE_SIZE = 100;
    let all = [];
    let cursor = null;
    while (true) {
      const q = [...queries, Query.limit(PAGE_SIZE)];
      if (cursor) q.push(Query.cursorAfter(cursor));
      const res = await withRetry(
        () => db.listDocuments(DB_ID, collectionId, q),
        `listDocs ${collectionId}`
      );
      all = all.concat(res.documents);
      if (res.documents.length < PAGE_SIZE) break;
      cursor = res.documents[res.documents.length - 1].$id;
    }
    return all;
  } catch (e) {
    if (e instanceof AppwriteException && e.code === 404) return [];
    console.warn(`[Appwrite] listDocs failed (${collectionId}): ${e.message}`);
    return [];
  }
}

/**
 * Delete a document. Returns true on success, false on error.
 */
async function deleteDoc(collectionId, documentId) {
  const db = getDB();
  if (!db) return false;
  try {
    await withRetry(
      () => db.deleteDocument(DB_ID, collectionId, documentId),
      `deleteDoc ${collectionId}/${documentId}`
    );
    return true;
  } catch (e) {
    if (e instanceof AppwriteException && e.code === 404) return true; // already gone
    console.warn(`[Appwrite] deleteDoc failed (${collectionId}/${documentId}): ${e.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Data serialisation helpers
// ---------------------------------------------------------------------------

/** Parse JSON safely; returns fallback on parse error. */
function safeJSON(str, fallback = null) {
  try { return JSON.parse(str); } catch { return fallback; }
}

// ---------------------------------------------------------------------------
// Per-collection sync functions
// ---------------------------------------------------------------------------

/** Sync a "single document" collection – the whole value is one doc. */
async function syncSingleDoc(collectionId, docId, value) {
  if (value === undefined) return;
  return upsertDoc(collectionId, docId, { data: JSON.stringify(value) });
}

/** Load a "single document" collection. Returns parsed value or null. */
async function loadSingleDoc(collectionId, docId) {
  const doc = await getDoc(collectionId, docId);
  if (!doc) return null;
  return safeJSON(doc.data);
}

/**
 * Sync a "map" collection where each key becomes its own document.
 * mapObj: { [entityId]: value }
 * collectionId: which Appwrite collection to write to
 */
async function syncMapCollection(collectionId, mapObj) {
  if (!mapObj || typeof mapObj !== 'object') return;
  const entries = Object.entries(mapObj);
  for (const [entityId, value] of entries) {
    await upsertDoc(collectionId, entityId, {
      entityId,
      data: JSON.stringify(value),
    });
  }
}

/**
 * Load a "map" collection into an object { [entityId]: parsedValue }.
 */
async function loadMapCollection(collectionId) {
  const docs = await listDocs(collectionId);
  const result = {};
  for (const doc of docs) {
    const val = safeJSON(doc.data);
    if (val !== null) result[doc.$id] = val;
  }
  return result;
}

/**
 * Sync an "array" collection where each element becomes a document.
 * Each element must have an `id` field used as the documentId.
 */
async function syncArrayCollection(collectionId, arr) {
  if (!Array.isArray(arr)) return;
  for (const item of arr) {
    if (!item || !item.id) continue;
    await upsertDoc(collectionId, String(item.id), {
      entityId: String(item.id),
      data: JSON.stringify(item),
    });
  }
}

/**
 * Load an "array" collection into a JS array.
 */
async function loadArrayCollection(collectionId) {
  const docs = await listDocs(collectionId);
  return docs.map(doc => safeJSON(doc.data)).filter(v => v !== null);
}

// ---------------------------------------------------------------------------
// Public API: syncDB / loadDB
// ---------------------------------------------------------------------------

/**
 * Sync the entire in-memory db to Appwrite.
 * Called in the background after every saveDB(); errors are non-fatal.
 */
export async function syncDB(db) {
  if (!getDB()) return; // not configured
  try {
    await Promise.all([
      // Single-document collections
      syncSingleDoc(COLLECTION_IDS.subjects,      'all',    db.subjects),
      syncSingleDoc(COLLECTION_IDS.subjectLevels, 'all',    db.subjectLevels),
      syncSingleDoc(COLLECTION_IDS.subjectTutors, 'all',    db.subjectTutors),
      syncSingleDoc(COLLECTION_IDS.reviewConfig,  'config', db.reviewConfig),
      syncSingleDoc(COLLECTION_IDS.modmail,       'all',    db.modmail),
      syncSingleDoc(COLLECTION_IDS.initMessage,   'config', { message: db.initMessage }),
      syncSingleDoc(COLLECTION_IDS.nextTicketId,  'counter', db.nextTicketId),
      syncSingleDoc(COLLECTION_IDS.defaultEmbedColor, 'config', db.defaultEmbedColor),
      syncSingleDoc(COLLECTION_IDS.sticky,        'config', db.sticky),
      syncSingleDoc(COLLECTION_IDS.aiChannel,     'config', db.aiChannelId),
      syncSingleDoc(COLLECTION_IDS.keywords,      'all',    db.keywordAutomations),

      // Map / per-entity collections
      syncMapCollection(COLLECTION_IDS.tutorProfiles,      db.tutorProfiles),
      syncMapCollection(COLLECTION_IDS.studentAssignments, db.studentAssignments),
      syncMapCollection(COLLECTION_IDS.cooldowns,          db.cooldowns),
      syncMapCollection(COLLECTION_IDS.bumpLeaderboard,    db.bumpLeaderboard),
      syncMapCollection(COLLECTION_IDS.tickets,            db.tickets),
      syncMapCollection(COLLECTION_IDS.tempTutorAdd,       db._tempTutorAdd),
      syncMapCollection(COLLECTION_IDS.tempTutorRemove,    db._tempTutorRemove),

      // Array collections
      syncArrayCollection(COLLECTION_IDS.pendingReviews, db.pendingReviews),
    ]);
    console.log('[BotDB] DB synced successfully.');
  } catch (e) {
    console.warn('[BotDB] syncDB encountered an error:', e.message);
  }
}

/**
 * Load the entire db from Appwrite.
 * Returns a partial db object (only fields that exist in Appwrite) or null
 * if Appwrite is not configured or all reads fail.
 */
export async function loadDB() {
  if (!getDB()) return null;

  try {
    const [
      subjects,
      subjectLevels,
      subjectTutors,
      reviewConfig,
      modmailRaw,
      initMessageRaw,
      nextTicketId,
      defaultEmbedColor,
      sticky,
      aiChannelId,
      keywordAutomations,
      tutorProfiles,
      studentAssignments,
      pendingReviews,
      cooldowns,
      bumpLeaderboard,
      tickets,
      tempTutorAdd,
      tempTutorRemove,
    ] = await Promise.all([
      loadSingleDoc(COLLECTION_IDS.subjects,      'all'),
      loadSingleDoc(COLLECTION_IDS.subjectLevels, 'all'),
      loadSingleDoc(COLLECTION_IDS.subjectTutors, 'all'),
      loadSingleDoc(COLLECTION_IDS.reviewConfig,  'config'),
      loadSingleDoc(COLLECTION_IDS.modmail,       'all'),
      loadSingleDoc(COLLECTION_IDS.initMessage,   'config'),
      loadSingleDoc(COLLECTION_IDS.nextTicketId,  'counter'),
      loadSingleDoc(COLLECTION_IDS.defaultEmbedColor, 'config'),
      loadSingleDoc(COLLECTION_IDS.sticky,        'config'),
      loadSingleDoc(COLLECTION_IDS.aiChannel,     'config'),
      loadSingleDoc(COLLECTION_IDS.keywords,      'all'),
      loadMapCollection(COLLECTION_IDS.tutorProfiles),
      loadMapCollection(COLLECTION_IDS.studentAssignments),
      loadArrayCollection(COLLECTION_IDS.pendingReviews),
      loadMapCollection(COLLECTION_IDS.cooldowns),
      loadMapCollection(COLLECTION_IDS.bumpLeaderboard),
      loadMapCollection(COLLECTION_IDS.tickets),
      loadMapCollection(COLLECTION_IDS.tempTutorAdd),
      loadMapCollection(COLLECTION_IDS.tempTutorRemove),
    ]);

    const result = {};

    if (subjects      !== null) result.subjects      = subjects;
    if (subjectLevels !== null) result.subjectLevels = subjectLevels;
    if (subjectTutors !== null) result.subjectTutors = subjectTutors;
    if (reviewConfig  !== null) result.reviewConfig  = reviewConfig;
    if (modmailRaw    !== null) result.modmail       = modmailRaw;
    if (initMessageRaw!== null && initMessageRaw.message !== undefined)
      result.initMessage = initMessageRaw.message;
    if (nextTicketId  !== null) result.nextTicketId  = nextTicketId;
    if (defaultEmbedColor !== null) result.defaultEmbedColor = defaultEmbedColor;
    if (sticky        !== null) result.sticky        = sticky;
    if (aiChannelId   !== null) result.aiChannelId   = aiChannelId;
    if (keywordAutomations !== null) result.keywordAutomations = keywordAutomations;

    if (tutorProfiles      && Object.keys(tutorProfiles).length)      result.tutorProfiles      = tutorProfiles;
    if (studentAssignments && Object.keys(studentAssignments).length) result.studentAssignments = studentAssignments;
    if (pendingReviews     && pendingReviews.length)                   result.pendingReviews     = pendingReviews;
    if (cooldowns          && Object.keys(cooldowns).length)           result.cooldowns          = cooldowns;
    if (bumpLeaderboard    && Object.keys(bumpLeaderboard).length)     result.bumpLeaderboard    = bumpLeaderboard;
    if (tickets            && Object.keys(tickets).length)             result.tickets            = tickets;
    if (tempTutorAdd       && Object.keys(tempTutorAdd).length)        result._tempTutorAdd      = tempTutorAdd;
    if (tempTutorRemove    && Object.keys(tempTutorRemove).length)     result._tempTutorRemove   = tempTutorRemove;

    // Return null if we got nothing useful from Appwrite
    return Object.keys(result).length > 0 ? result : null;
  } catch (e) {
    console.warn('[BotDB] loadDB failed:', e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Granular per-collection helpers (for targeted updates)
// ---------------------------------------------------------------------------

/** Update a single tutor profile. */
export async function saveTutorProfile(tutorId, profile) {
  return upsertDoc(COLLECTION_IDS.tutorProfiles, String(tutorId), {
    entityId: String(tutorId),
    data: JSON.stringify(profile),
  });
}

/** Update a single student assignment. */
export async function saveStudentAssignment(studentId, assignment) {
  return upsertDoc(COLLECTION_IDS.studentAssignments, String(studentId), {
    entityId: String(studentId),
    data: JSON.stringify(assignment),
  });
}

/** Remove a student assignment. */
export async function deleteStudentAssignment(studentId) {
  return deleteDoc(COLLECTION_IDS.studentAssignments, String(studentId));
}

/** Upsert a pending review. */
export async function savePendingReview(review) {
  if (!review || !review.id) return null;
  return upsertDoc(COLLECTION_IDS.pendingReviews, String(review.id), {
    entityId: String(review.id),
    data: JSON.stringify(review),
  });
}

/** Delete a pending review. */
export async function deletePendingReview(reviewId) {
  return deleteDoc(COLLECTION_IDS.pendingReviews, String(reviewId));
}

/** Update a single ticket. */
export async function saveTicket(ticketId, ticket) {
  return upsertDoc(COLLECTION_IDS.tickets, String(ticketId), {
    entityId: String(ticketId),
    data: JSON.stringify(ticket),
  });
}

/** Delete a ticket. */
export async function deleteTicket(ticketId) {
  return deleteDoc(COLLECTION_IDS.tickets, String(ticketId));
}

/** Check whether the Appwrite client is configured and reachable. */
export function isConfigured() {
  return !!(ENDPOINT && PROJECT_ID && API_KEY);
}
