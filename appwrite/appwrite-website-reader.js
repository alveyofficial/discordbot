/**
 * appwrite/appwrite-website-reader.js
 *
 * Read-only client for the website's Appwrite database.
 *
 * This module exposes tutor/subject/pricing data that the AI assistant
 * (Alvey) uses to answer questions. The bot NEVER writes to this database.
 *
 * Required env vars (all optional — AI degrades gracefully if missing):
 *   APPWRITE_WEBSITE_ENDPOINT    — Appwrite endpoint for the website project
 *   APPWRITE_WEBSITE_PROJECT_ID  — project ID for the website database
 *   APPWRITE_WEBSITE_API_KEY     — API key with read permission
 *   APPWRITE_WEBSITE_DB_ID       — database ID on the website project
 */

import { Client, Databases, Query, AppwriteException } from 'node-appwrite';
import { WEBSITE_COLLECTION_IDS } from './collection-ids.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ENDPOINT   = process.env.APPWRITE_WEBSITE_ENDPOINT;
const PROJECT_ID = process.env.APPWRITE_WEBSITE_PROJECT_ID;
const API_KEY    = process.env.APPWRITE_WEBSITE_API_KEY;
const DB_ID      = process.env.APPWRITE_WEBSITE_DB_ID;

let _databases = null;

/**
 * Returns true if all required website DB env vars are present.
 */
export function isWebsiteConfigured() {
  return !!(ENDPOINT && PROJECT_ID && API_KEY && DB_ID);
}

function getDB() {
  if (_databases) return _databases;
  if (!isWebsiteConfigured()) return null;
  const client = new Client()
    .setEndpoint(ENDPOINT)
    .setProject(PROJECT_ID)
    .setKey(API_KEY);
  _databases = new Databases(client);
  return _databases;
}

// ---------------------------------------------------------------------------
// Low-level helpers (read-only)
// ---------------------------------------------------------------------------

function safeJSON(str, fallback = null) {
  try { return JSON.parse(str); } catch { return fallback; }
}

async function listAllDocs(collectionId, queries = []) {
  const db = getDB();
  if (!db) return [];
  try {
    const PAGE_SIZE = 100;
    let all = [];
    let cursor = null;
    while (true) {
      const q = [...queries, Query.limit(PAGE_SIZE)];
      if (cursor) q.push(Query.cursorAfter(cursor));
      const res = await db.listDocuments(DB_ID, collectionId, q);
      all = all.concat(res.documents);
      if (res.documents.length < PAGE_SIZE) break;
      cursor = res.documents[res.documents.length - 1].$id;
    }
    return all;
  } catch (e) {
    if (e instanceof AppwriteException && e.code === 404) return [];
    console.warn(`[WebsiteDB] listAllDocs failed (${collectionId}): ${e.message}`);
    return [];
  }
}

async function getSingleDoc(collectionId, documentId) {
  const db = getDB();
  if (!db) return null;
  try {
    return await db.getDocument(DB_ID, collectionId, documentId);
  } catch (e) {
    if (e instanceof AppwriteException && e.code === 404) return null;
    console.warn(`[WebsiteDB] getDocument failed (${collectionId}/${documentId}): ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Context loader
// ---------------------------------------------------------------------------

/**
 * Load all tutor/subject/pricing data from the website database.
 *
 * Returns an object with:
 *   subjects       — array of subject name strings (or objects with {name, level})
 *   subjectLevels  — map subjectName → levelKey
 *   subjectTutors  — map subjectName → [tutorId, ...]
 *   tutorProfiles  — map tutorId → profile object
 *   ads            — array of ad objects with pricing/details
 *
 * Returns null if the website DB is not configured.
 */
export async function loadTutorContext() {
  if (!isWebsiteConfigured()) return null;

  try {
    const [subjectDocs, subjectLevelDocs, subjectTutorDocs, tutorProfileDocs, adDocs] = await Promise.all([
      listAllDocs(WEBSITE_COLLECTION_IDS.subjects),
      listAllDocs(WEBSITE_COLLECTION_IDS.subjectLevels),
      listAllDocs(WEBSITE_COLLECTION_IDS.subjectTutors),
      listAllDocs(WEBSITE_COLLECTION_IDS.tutorProfiles),
      listAllDocs(WEBSITE_COLLECTION_IDS.ads),
    ]);

    // Subjects: may be a single-doc collection storing JSON or individual docs
    let subjects = [];
    if (subjectDocs.length === 1 && subjectDocs[0].$id === 'all') {
      subjects = safeJSON(subjectDocs[0].data, []);
    } else {
      subjects = subjectDocs.map(d => safeJSON(d.data) ?? d.name ?? d.$id).filter(Boolean);
    }

    // SubjectLevels
    let subjectLevels = {};
    if (subjectLevelDocs.length === 1 && subjectLevelDocs[0].$id === 'all') {
      subjectLevels = safeJSON(subjectLevelDocs[0].data, {});
    } else {
      for (const doc of subjectLevelDocs) {
        const val = safeJSON(doc.data);
        if (val && typeof val === 'object') Object.assign(subjectLevels, val);
      }
    }

    // SubjectTutors
    let subjectTutors = {};
    if (subjectTutorDocs.length === 1 && subjectTutorDocs[0].$id === 'all') {
      subjectTutors = safeJSON(subjectTutorDocs[0].data, {});
    } else {
      for (const doc of subjectTutorDocs) {
        const val = safeJSON(doc.data);
        if (val !== null) subjectTutors[doc.$id] = val;
      }
    }

    // TutorProfiles
    const tutorProfiles = {};
    for (const doc of tutorProfileDocs) {
      const val = safeJSON(doc.data) ?? doc;
      if (val) tutorProfiles[doc.$id] = val;
    }

    // Ads (pricing info)
    const ads = adDocs.map(doc => {
      const source = safeJSON(doc.Source || doc.source || null);
      return {
        id: doc.$id,
        title: doc.title || '',
        description: doc.description || doc.body || '',
        tutorId: doc.createdBy || doc.tutorId || (source?.ad?.tutorId) || null,
        adCode: doc.adCode || (source?.ad?.adCode) || null,
        fullDetails: source?.ad?.fullDetails || null,
        status: doc.status || 'active',
      };
    }).filter(a => a.status === 'active');

    return { subjects, subjectLevels, subjectTutors, tutorProfiles, ads };
  } catch (e) {
    console.warn('[WebsiteDB] loadTutorContext failed:', e.message);
    return null;
  }
}
