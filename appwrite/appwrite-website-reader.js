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
// Low-level helper (read-only, paginated)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Context loader
// ---------------------------------------------------------------------------

/**
 * Load all tutor/subject data from the website database.
 *
 * Returns:
 *   tutors   — array of active tutor profile objects (mapped from real schema)
 *   reviews  — map of tutorId → { avg: number, snippets: string[] }
 *   subjects — array of unique subject name strings
 *
 * Returns null if the website DB is not configured.
 */
export async function loadTutorContext() {
  if (!isWebsiteConfigured()) return null;

  try {
    // Fetch tutor_profiles (active only), tutor_reviews, and optionally subjects
    const [tutorProfileDocs, reviewDocs, subjectDocs] = await Promise.all([
      listAllDocs(WEBSITE_COLLECTION_IDS.tutorProfiles, [Query.equal('active', true)]),
      listAllDocs(WEBSITE_COLLECTION_IDS.tutor_reviews, [
        Query.equal('isPublic', true),
        Query.equal('isDeleted', false),
      ]),
      listAllDocs(WEBSITE_COLLECTION_IDS.subjects),
    ]);

    // --- Map tutor profiles directly from real schema fields ---
    const tutors = tutorProfileDocs.map(doc => ({
      id:           doc.$id,
      displayName:  doc.displayName  || '',
      slug:         doc.slug         || '',
      headline:     doc.headline     || '',
      shortBio:     doc.shortBio     || '',
      subjects:     Array.isArray(doc.subjects)  ? doc.subjects  : [],
      levels:       Array.isArray(doc.levels)    ? doc.levels    : [],
      languages:    Array.isArray(doc.languages) ? doc.languages : [],
      hourlyRate:   doc.hourlyRate   ?? null,
      availability: doc.availability || '',
      responseTime: doc.responseTime || '',
      rating:       typeof doc.rating      === 'number' ? doc.rating      : null,
      reviewCount:  typeof doc.reviewCount === 'number' ? doc.reviewCount : 0,
      verified:     doc.verified  === true,
      featured:     doc.featured  === true,
    }));

    // --- Aggregate reviews by tutorId ---
    const reviewMap = {};
    for (const doc of reviewDocs) {
      const tid = doc.tutorId;
      if (!tid) continue;
      if (!reviewMap[tid]) reviewMap[tid] = { ratings: [], snippets: [] };
      if (typeof doc.rating === 'number') reviewMap[tid].ratings.push(doc.rating);
      if (doc.body && typeof doc.body === 'string') {
        // Keep up to 3 recent snippets (trimmed to 120 chars each)
        if (reviewMap[tid].snippets.length < 3) {
          reviewMap[tid].snippets.push(doc.body.trim().slice(0, 120));
        }
      }
    }
    const reviews = {};
    for (const [tid, data] of Object.entries(reviewMap)) {
      const avg = data.ratings.length
        ? Math.round((data.ratings.reduce((s, r) => s + r, 0) / data.ratings.length) * 10) / 10
        : null;
      reviews[tid] = { avg, snippets: data.snippets };
    }

    // --- Build subjects list ---
    // Prefer the subjects collection; fall back to deriving from tutor profiles.
    let subjects = subjectDocs
      .map(d => d.name || d.title || d.$id)
      .filter(Boolean);

    if (subjects.length === 0) {
      // Derive unique subjects from all active tutor profiles
      const seen = new Set();
      for (const tutor of tutors) {
        for (const s of tutor.subjects) {
          if (s && !seen.has(s)) { seen.add(s); subjects.push(s); }
        }
      }
    }

    console.log(`[Alvey] Context refreshed (WebsiteDB) - ${tutors.length} tutors, ${subjects.length} subjects.`);

    return { tutors, reviews, subjects };
  } catch (e) {
    console.warn('[WebsiteDB] loadTutorContext failed:', e.message);
    return null;
  }
}
