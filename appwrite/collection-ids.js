/**
 * appwrite/collection-ids.js
 *
 * Constants for all Appwrite collection IDs used by the Discord bot.
 *
 * Two databases:
 *
 * BOT DATABASE (APPWRITE_BOT_DB_ID / APPWRITE_DB_ID fallback) — read/write:
 *   All operational bot data lives here exclusively.
 *
 * WEBSITE DATABASE (APPWRITE_WEBSITE_DB_ID) — read-only:
 *   Tutor/subject/pricing data shared with the public website.
 *   The bot NEVER writes to this database.
 */

// Bot-only database ID (with backward-compat fallback for APPWRITE_DB_ID)
export const DB_ID = process.env.APPWRITE_BOT_DB_ID || process.env.APPWRITE_DB_ID || 'discordbot';

// Bot-only collections (all read/write operations)
export const COLLECTION_IDS = {
  // Operational bot data
  subjects:            'discordSubjects',
  subjectLevels:       'discordSubjectLevels',
  subjectTutors:       'discordSubjectTutors',
  tutorProfiles:       'discordTutorProfiles',
  studentAssignments:  'discordStudentAssignments',
  pendingReviews:      'discordPendingReviews',
  reviewConfig:        'discordReviewConfig',
  modmail:             'discordModmail',
  initMessage:         'discordInitMessage',
  nextTicketId:        'discordNextTicketId',
  defaultEmbedColor:   'discordDefaultEmbedColor',
  sticky:              'discordSticky',
  aiChannel:           'discordAiChannel',

  // Discord-Only (not synced with website)
  cooldowns:           'discordCooldowns',
  bumpLeaderboard:     'discordBumpLeaderboard',
  tickets:             'discordTickets',
  keywords:            'discordKeywords',
  tempTutorAdd:        'discordTempTutorAdd',
  tempTutorRemove:     'discordTempTutorRemove',
};

export const BOT_COLLECTION_IDS = COLLECTION_IDS;

// Website database collection IDs (read-only, used by appwrite-website-reader.js)
export const WEBSITE_COLLECTION_IDS = {
  tutorProfiles:     'tutor_profiles',
  tutor_reviews:     'tutor_reviews',
  subjects:          'subjects',           // may be empty — handled gracefully
  subjectCategories: 'subject_categories',
};
