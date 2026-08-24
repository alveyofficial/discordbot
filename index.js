/**
 * index.js
 * Ticket-matchmaker main file
 * Node 20+, discord.js v14
 *
 * Changes included
 * - All original features retained
 * - notifyStaffError helper that posts to STAFF_CHAT_ID and mentions staff roles
 * - initModmail passed notifyError to forward errors from modmail
 * - /close and modmail close flows changed to two-step select + modal (see comments)
 * - Student/tutor assignment, /student add, /student remove added
 * - Review reminders scheduling, pending reviews stored and require staff approval
 * - /reviewreminder modal to change reminder delay
 * - Timestamps in transcripts use Discord timestamp format <t:SECONDS:f>
 * - /embedcolor updates sticky and ad embed colors, now affects sticky as before
 */
import 'newrelic';
import fs from 'fs';
import { runStartupPreflight } from './startup-check.js';
import dotenv from 'dotenv';
dotenv.config();
runStartupPreflight();

import * as appwriteClient from './appwrite/appwrite-client.js';

import pkg from 'discord.js';
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  ChannelType,
  PermissionFlagsBits,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  EmbedBuilder,
  PermissionsBitField,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  AttachmentBuilder
} = pkg;

// ---------------- WEB SERVER SETUP ----------------

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { setupWebServer } from "./webserver.js";

// ES module dirname fix
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 9904;
const app = express();

// Setup web server routes (authentication, API, etc.)
setupWebServer(app);

// Start web server
app.listen(PORT, () => {
  console.log(`Webapp running on port ${PORT}`);
});

// --------------- END WEB SERVER SETUP ---------------



import initModmail from './modmail.js';
import initAIAssistant from './ai-assistant.js';


// env
const {
  BOT_TOKEN,
  GUILD_ID,
  STAFF_ROLE_ID,
  MANAGER_ROLE_ID,
  ISOFUSIE_ROLE_ID,
  STAFF_CHAT_ID,
  FIND_A_TUTOR_CHANNEL_ID,
  TUTORS_FEED_CHANNEL_ID,
  TICKET_CATEGORY_ID,
  TRANSCRIPTS_CHANNEL_ID = '1443735527596621934', // "transcripts" channel (production fallback; override via env var)
  TUTOR_CHAT_CHANNEL_ID,
  TUTOR_POLICIES_CHANNEL_ID,
  MODMAIL_CATEGORY_ID,
  MODMAIL_TRANSCRIPTS_CHANNEL_ID,
  BUMP_CHANNEL_ID, // Optional: Channel ID where bump tracking should listen (if not set, listens in all channels)
  AI_CHANNEL_ID
} = process.env;

const TUTORS_LOUNGE_CATEGORY_ID = '1429172429304889427';
const BOT_DEVELOPER_ROLE_ID = process.env.BOT_DEVELOPER_ROLE_ID || '1443743476192907284';

const REQUIRED_ENV_VARS = {
  BOT_TOKEN,
  GUILD_ID,
  STAFF_ROLE_ID,
  FIND_A_TUTOR_CHANNEL_ID,
  TUTORS_FEED_CHANNEL_ID,
};
const missingVars = Object.entries(REQUIRED_ENV_VARS)
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missingVars.length > 0) {
  console.error(`Missing required environment variable(s): ${missingVars.join(', ')}`);
  console.error('Set these in your hosting provider\'s environment variables panel (not in the startup command).');
  process.exit(1);
}

const DATA_FILE = './data.json';
let db = {
  nextTicketId: 1,
  subjects: ['IGCSE Accounting', 'IGCSE Maths', 'IGCSE Add Maths'],
  subjectLevels: {}, // map subjectName -> levelKey (e.g. { 'IGCSE/GCSE Maths': 'igcse' })
  subjectTutors: { 'IGCSE Maths': ['742420325559435375', '873095080938975232'] }, // tutor user ids
  initMessage: 'Hello, thanks for requesting a tutor for **{subject}**. Please tell us your topic, availability, timezone. Do not post contact info.',
  keywordAutomations: [],
  aiChannelId: null,
  tickets: {},
  cooldowns: {},
  sticky: null, // { title, body, color, messageId }
  defaultEmbedColor: null,
  // Review system
  tutorProfiles: {}, // tutorId -> { addedAt, students: [userId,...], reviews: [], rating: {count,avg} }
  studentAssignments: {}, // userId -> { tutorId, subject, assignedAt, reviewScheduledAt }
  pendingReviews: [], // { id, studentId, tutorId, subject, rating, text, submittedAt, approved: false }
  reviewConfig: { delaySeconds: 1296000 }, // default 15 days in seconds
  // Bump leaderboard
  bumpLeaderboard: {}, // userId -> { count: number, lastBump: timestamp }
  // Modmail helpers placed by modmail.js
  _modmail_helpers: {}
};

// ---------------------------------------------------------------------------
// Appwrite background sync (debounced to avoid flooding the API)
// ---------------------------------------------------------------------------

let _appwriteSyncTimer = null;

function scheduleAppwriteSync() {
  if (!appwriteClient.isConfigured()) return;
  if (_appwriteSyncTimer) clearTimeout(_appwriteSyncTimer);
  _appwriteSyncTimer = setTimeout(() => {
    _appwriteSyncTimer = null;
    appwriteClient.syncDB(db).catch(e => console.warn('[Appwrite] Background sync failed:', e.message));
  }, 5000); // coalesce rapid saves into one sync every 5s
}

function saveDB() {
  if (!appwriteClient.isConfigured()) {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); } catch (e) { console.warn('Failed to save DB', e); }
    return;
  }
  scheduleAppwriteSync();
}

// Ensure labels passed to Discord input builders meet max-length requirements
function clampLabel(s, max = 45) {
  if (typeof s !== 'string') return '';
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 3)) + '...';
}

const PAGINATED_PREV_VALUE = '__page_prev__';
const PAGINATED_NEXT_VALUE = '__page_next__';

function compareStringsCaseInsensitive(a, b) {
  return String(a || '').toLowerCase().localeCompare(String(b || '').toLowerCase());
}

function sortStringsCaseInsensitive(values) {
  return [...values].sort(compareStringsCaseInsensitive);
}

function parsePagedCustomId(customId) {
  const match = String(customId || '').match(/^(.*)\|__page__\|(\d+)$/);
  if (!match) return { baseCustomId: customId, page: 0 };
  return { baseCustomId: match[1], page: Number.parseInt(match[2], 10) || 0 };
}

function isPagedNavigationValue(value) {
  return value === PAGINATED_PREV_VALUE || value === PAGINATED_NEXT_VALUE;
}

function getPagedNavigationTarget(currentPage, value) {
  return value === PAGINATED_PREV_VALUE ? Math.max(0, currentPage - 1) : currentPage + 1;
}

function buildPaginatedSelectMenu({ baseCustomId, placeholder, options, page = 0, required = false }) {
  const rawOptions = Array.isArray(options) ? options : [];
  if (rawOptions.length === 0) {
    throw new Error(`buildPaginatedSelectMenu called without options for ${baseCustomId}`);
  }
  const needsPagination = rawOptions.length > 25;
  const pageSize = needsPagination ? 23 : 25;
  const maxPage = Math.max(0, Math.ceil(rawOptions.length / pageSize) - 1);
  const safePage = Math.min(Math.max(0, page), maxPage);
  const pageOptions = rawOptions.slice(safePage * pageSize, (safePage + 1) * pageSize).map(opt => ({ ...opt }));
  if (needsPagination && safePage > 0) {
    pageOptions.unshift({
      label: '⬅ Previous page',
      value: PAGINATED_PREV_VALUE,
      description: `Go to page ${safePage} of ${maxPage + 1}`.substring(0, 100)
    });
  }
  if (needsPagination && safePage < maxPage) {
    pageOptions.push({
      label: 'Next page ➡',
      value: PAGINATED_NEXT_VALUE,
      description: `Go to page ${safePage + 2} of ${maxPage + 1}`.substring(0, 100)
    });
  }
  const finalPlaceholder = needsPagination ? `${placeholder} | Page ${safePage + 1}/${maxPage + 1}` : placeholder;
  return new StringSelectMenuBuilder()
    .setCustomId(`${baseCustomId}|__page__|${safePage}`)
    .setPlaceholder(finalPlaceholder)
    .addOptions(pageOptions)
    .setRequired(required);
}

const SUBJECT_LEVEL_LABELS = {
  igcse: 'IGCSE',
  a_level: 'A Level',
  university: 'University',
  below_igcse: 'Below IGCSE',
  language: 'Language',
  test_prep: 'Test Prep',
  other: 'Other'
};

function normalizeSubjectLevelKey(rawInput) {
  const value = String(rawInput || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
  if (!value) return null;
  if (['igcse', 'gcse', 'o_level', 'olevel'].includes(value)) return 'igcse';
  if (['a_level', 'alevel', 'as_level', 'as_al', 'as/a_level', 'as/al'].includes(value)) return 'a_level';
  if (['below_igcse', 'below_gcse', 'below'].includes(value)) return 'below_igcse';
  if (['university', 'uni'].includes(value)) return 'university';
  if (['language', 'languages'].includes(value)) return 'language';
  if (['test_prep', 'testprep', 'exam_prep'].includes(value)) return 'test_prep';
  if (value === 'other') return 'other';
  return null;
}

function detectLevelFromSubject(subject) {
  const text = String(subject || '').toLowerCase();
  if (!text) return null;
  if (/\b(igcse|gcse|o[-\s]?level)\b/.test(text)) return 'igcse';
  if (/\b(as\/al|as\s*\/\s*a|a[-\s]?level|alevel)\b/.test(text)) return 'a_level';
  if (/\b(university|uni|college)\b/.test(text)) return 'university';
  if (/\b(below\s+(igcse|gcse)|primary|middle school)\b/.test(text)) return 'below_igcse';
  if (/\b(language|english|arabic|french|german|spanish|mandarin|chinese|urdu|hindi|malay)\b/.test(text)) return 'language';
  if (/\b(ielts|sat|act|toefl|test prep|exam prep)\b/.test(text)) return 'test_prep';
  return null;
}

function getSubjectsForLevel(levelKey, { fallbackToAll = true } = {}) {
  const allSubjects = sortStringsCaseInsensitive(db.subjects || []);
  if (!levelKey) return allSubjects;
  const filteredSubjects = allSubjects.filter(subject => {
    const storedLevel = db.subjectLevels && db.subjectLevels[subject];
    const effectiveLevel = storedLevel || detectLevelFromSubject(subject) || 'other';
    return effectiveLevel === levelKey;
  });
  return filteredSubjects.length > 0 || !fallbackToAll ? filteredSubjects : allSubjects;
}

function normalizeSubjectKey(rawInput) {
  let value = String(rawInput || '').toLowerCase().trim();
  if (!value) return '';
  value = value.replace(/&/g, 'and');
  value = value.replace(/^(igcse\/gcse|igcse\/o-level|igcse|as\/al|as\/a\s+level|a\s+level|a-level|below\s+igcse|below_igcse|university|language|test\s*prep)\s+/i, '');
  value = value.replace(/[^a-z0-9\s]/g, ' ');
  value = value.replace(/\s+/g, ' ').trim();

  const replacements = [
    { from: /\bmathematics\b/g, to: 'maths' },
    { from: /\bmath\b/g, to: 'maths' },
    { from: /\badditional\b/g, to: 'add' },
    { from: /\badd\s+maths?\b/g, to: 'add maths' },
    { from: /\bict\b/g, to: 'information technology' },
    { from: /\binfo\s*technology\b/g, to: 'information technology' },
    { from: /\benglish\s+as\s+a\s+second\s+language\b/g, to: 'english second language' },
    { from: /\bfirst\s+language\s+english\b/g, to: 'first language english' }
  ];
  for (const { from, to } of replacements) {
    value = value.replace(from, to);
  }

  return value.replace(/\s+/g, ' ').trim();
}

function resolveCanonicalSubject(rawInput, { levelKey = null, fallbackToAll = true } = {}) {
  const input = String(rawInput || '').trim();
  if (!input) return { subject: null, suggestions: [] };
  const inputKey = normalizeSubjectKey(input);
  const pools = [];
  const levelSubjects = getSubjectsForLevel(levelKey, { fallbackToAll });
  pools.push(levelSubjects);
  const allSubjects = sortStringsCaseInsensitive(db.subjects || []);
  if (fallbackToAll && levelKey && levelSubjects !== allSubjects) pools.push(allSubjects);

  for (const subjects of pools) {
    const exact = subjects.find(subject => subject.toLowerCase() === input.toLowerCase());
    if (exact) return { subject: exact, suggestions: [] };
    const aliasMatches = inputKey ? subjects.filter(subject => normalizeSubjectKey(subject) === inputKey) : [];
    if (aliasMatches.length === 1) return { subject: aliasMatches[0], suggestions: [] };
    if (aliasMatches.length > 1) return { subject: null, suggestions: aliasMatches.slice(0, 5) };
    const startsWith = subjects.filter(subject => subject.toLowerCase().startsWith(input.toLowerCase()));
    if (startsWith.length === 1) return { subject: startsWith[0], suggestions: [] };
    const includes = subjects.filter(subject => subject.toLowerCase().includes(input.toLowerCase()));
    if (includes.length === 1) return { subject: includes[0], suggestions: [] };
    if (startsWith.length > 0) return { subject: null, suggestions: startsWith.slice(0, 5) };
    if (includes.length > 0) return { subject: null, suggestions: includes.slice(0, 5) };
  }

  return { subject: null, suggestions: [] };
}

function formatSubjectResolutionError(rawInput, suggestions = []) {
  const base = `Could not match subject "${String(rawInput || '').trim()}".`;
  if (!suggestions.length) return `${base} Please type the subject name exactly as it appears in \`/subject list\`.`;
  return `${base} Did you mean: ${suggestions.join(', ')}?`;
}

function getAllTutorIds() {
  return sortStringsCaseInsensitive(Array.from(new Set(Object.values(db.subjectTutors || {}).flat().map(id => String(id)))));
}

async function syncTutorsLoungeCategoryAccess() {
  try {
    if (!TUTORS_LOUNGE_CATEGORY_ID || !GUILD_ID) return;
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    if (!guild) return;

    const category = await guild.channels.fetch(TUTORS_LOUNGE_CATEGORY_ID).catch(() => null);
    if (!category || category.type !== ChannelType.GuildCategory) return;

    // Pre-fetch tutor members so Discord.js can resolve their IDs from cache.
    // Members who have left the guild are silently skipped.
    const tutorIds = getAllTutorIds();
    const resolvedTutorIds = (
      await Promise.all(
        tutorIds.map(userId =>
          guild.members.fetch(userId).then(() => userId).catch(() => null)
        )
      )
    ).filter(Boolean);

    const accessRoleIds = Array.from(new Set([MANAGER_ROLE_ID, ISOFUSIE_ROLE_ID].filter(Boolean).map(s => String(s).trim())));
    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
      ...accessRoleIds.map(rid => ({ id: rid, allow: [PermissionsBitField.Flags.ViewChannel] })),
      ...resolvedTutorIds.map(userId => ({ id: userId, allow: [PermissionsBitField.Flags.ViewChannel] }))
    ];

    await category.permissionOverwrites.set(overwrites);
  } catch (e) {
    console.warn('syncTutorsLoungeCategoryAccess failed', e?.message || e);
  }
}

function resolveTutorInput(rawInput) {
  const input = String(rawInput || '').trim();
  if (!input) return { tutorId: null, suggestions: [] };
  const mentionMatch = input.match(/^<@!?(\d+)>$/);
  const byId = mentionMatch ? mentionMatch[1] : input;
  const allTutorIds = getAllTutorIds();
  if (allTutorIds.includes(byId)) return { tutorId: byId, suggestions: [] };

  const tutorRecords = allTutorIds.map(id => {
    const profile = db.tutorProfiles?.[id] || {};
    const username = String(profile.username || '').trim();
    const tag = String(profile.tag || '').trim();
    return { id, username, tag };
  });
  const normalized = input.toLowerCase();
  const exact = tutorRecords.find(record => record.username.toLowerCase() === normalized || record.tag.toLowerCase() === normalized);
  if (exact) return { tutorId: exact.id, suggestions: [] };
  const startsWith = tutorRecords.filter(record => record.username.toLowerCase().startsWith(normalized) || record.tag.toLowerCase().startsWith(normalized));
  if (startsWith.length === 1) return { tutorId: startsWith[0].id, suggestions: [] };
  const includes = tutorRecords.filter(record => record.username.toLowerCase().includes(normalized) || record.tag.toLowerCase().includes(normalized));
  if (includes.length === 1) return { tutorId: includes[0].id, suggestions: [] };
  const suggestions = (startsWith.length ? startsWith : includes)
    .slice(0, 5)
    .map(record => record.username || record.tag || record.id);
  return { tutorId: null, suggestions };
}

function formatTutorResolutionError(rawInput, suggestions = []) {
  const base = `Could not match tutor "${String(rawInput || '').trim()}".`;
  if (!suggestions.length) return `${base} Use a mention, user ID, username, or tag for a tutor already in the database.`;
  return `${base} Did you mean: ${suggestions.join(', ')}?`;
}

function resolveDiscordUserInput(rawInput) {
  const input = String(rawInput || '').trim();
  if (!input) return { userId: null };
  const mentionMatch = input.match(/^<@!?(\d+)>$/);
  const byId = mentionMatch ? mentionMatch[1] : input;
  if (/^\d+$/.test(byId)) return { userId: byId };
  return { userId: null };
}

function slugifyChannelName(raw) {
  const base = String(raw || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return base || 'user';
}

function buildTicketChannelName(user, subject = '') {
  const username = user?.username || user?.tag || '';
  const suffix = String(user?.id || '').slice(-4) || '0000';
  const userSlug = slugifyChannelName(username);
  const subjectSlug = subject ? slugifyChannelName(subject) : '';
  const base = subjectSlug ? `ticket-${userSlug}-${subjectSlug}` : `ticket-${userSlug}`;
  return `${base}-${suffix}`.slice(0, 90);
}

function findOpenTicketForUserSubject(userId, subject) {
  const targetKey = normalizeSubjectKey(subject);
  if (!userId || !targetKey) return null;
  for (const [code, ticket] of Object.entries(db.tickets || {})) {
    if (!ticket || String(ticket.studentId) !== String(userId)) continue;
    const ticketKey = normalizeSubjectKey(ticket.subject);
    if (ticketKey && ticketKey === targetKey) return { code, ticket };
  }
  return null;
}

async function createEnquiryTicketFromInteraction(interaction, { subject, selectedTutorId = null, source = 'enquire', creatingMessage = 'Creating your ticket...', successVerb = 'Continue in' } = {}) {
  const user = interaction.user;
  const guild = interaction.guild;
  if (!guild || !user) {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Tickets can only be created inside the server.', ephemeral: true }).catch(() => {});
    }
    return null;
  }

  const safeSubject = String(subject || '').trim() || 'Tutoring enquiry';
  const existing = findOpenTicketForUserSubject(user.id, safeSubject);
  if (existing) {
    const existingChannel = await guild.channels.fetch(existing.ticket.ticketChannelId).catch(() => null);
    const where = existingChannel ? ` in <#${existingChannel.id}>` : '';
    const content = `You already have an open ticket for **${existing.ticket.subject}**${where}. Please close it before opening another.`;
    if (interaction.deferred || interaction.replied) await interaction.editReply({ content }).catch(() => {});
    else await interaction.reply({ content, ephemeral: true }).catch(() => {});
    return null;
  }

  const last = db.cooldowns[user.id] || 0;
  const cooldownMs = 3 * 60 * 1000;
  const elapsed = Date.now() - last;
  if (elapsed < cooldownMs) {
    const secs = Math.ceil((cooldownMs - elapsed) / 1000);
    const content = `Please wait ${secs}s before opening another ticket.`;
    if (interaction.deferred || interaction.replied) await interaction.editReply({ content }).catch(() => {});
    else await interaction.reply({ content, ephemeral: true }).catch(() => {});
    return null;
  }

  if (!interaction.deferred && !interaction.replied) {
    await interaction.reply({ content: creatingMessage, ephemeral: true }).catch(() => {});
  } else {
    await interaction.editReply({ content: creatingMessage }).catch(() => {});
  }

  const code = generateTicketNumber();
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
    ...getStaffRoleIds().map(rid => ({ id: rid, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles] })),
    { id: user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
    { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageMessages, PermissionsBitField.Flags.EmbedLinks] }
  ];
  const channelData = { name: buildTicketChannelName(user, safeSubject), type: 0, permissionOverwrites: overwrites };
  if (TICKET_CATEGORY_ID) channelData.parent = TICKET_CATEGORY_ID;
  const ticketChannel = await guild.channels.create(channelData).catch(err => {
    console.error('create channel failed', err);
    try { notifyStaffError(err, `${source} create channel`, interaction); } catch {}
    return null;
  });
  if (!ticketChannel) {
    await interaction.editReply({ content: 'Failed to create ticket channel.' }).catch(() => {});
    return null;
  }

  const initMsg = String(db.initMessage || '').replace('{subject}', safeSubject);
  await ticketChannel.send({ content: `<@${user.id}>\n${initMsg}` }).catch(() => {});

  db.tickets[code] = {
    ticketChannelId: ticketChannel.id,
    studentId: user.id,
    studentName: user.username,
    studentTag: user.tag,
    tutorMessageId: null,
    tutorThreadId: null,
    selectedTutorId: selectedTutorId || null,
    subject: safeSubject,
    approved: false,
    awaitingApproval: false,
    tutorCount: 0,
    tutorMap: {},
    messages: [],
    createdAt: Date.now()
  };
  db.cooldowns[user.id] = Date.now();
  saveDB();

  await interaction.editReply({ content: `Ticket created for <@${user.id}> (code **${code}**). ${successVerb} <#${ticketChannel.id}>.` }).catch(() => {});
  await ticketChannel.send(`Ticket created for <@${user.id}> (code **${code}**), subject: ${safeSubject}`).catch(() => {});
  return { code, ticketChannel };
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function messageContainsTrigger(content, keyword) {
  const haystack = String(content || '').toLowerCase();
  const needle = String(keyword || '').trim().toLowerCase();
  if (!haystack || !needle) return false;
  if (/^[\w\s-]+$/i.test(needle)) {
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(needle)}([^\\p{L}\\p{N}_]|$)`, 'iu');
    return pattern.test(content);
  }
  return haystack.includes(needle);
}

function buildSubjectSelectOptions(subjects) {
  return sortStringsCaseInsensitive(subjects || []).map(subject => ({
    label: subject.substring(0, 100),
    value: subject.substring(0, 100),
    description: `Subject: ${subject}`.substring(0, 100)
  }));
}

async function buildTutorSelectOptions(guild, tutorIds, { includeNoneOption = false, noneLabel = 'None', noneDescription = 'No selection' } = {}) {
  const options = [];
  if (includeNoneOption) {
    options.push({
      label: noneLabel,
      value: 'none',
      description: noneDescription
    });
  }
  for (const tid of tutorIds) {
    let label = `User ID: ${tid}`;
    let description = '';
    try {
      const member = guild ? await guild.members.fetch(tid).catch(() => null) : null;
      if (member?.user) {
        label = member.user.username;
        description = `(${member.user.tag})`;
      } else {
        const user = await client.users.fetch(tid).catch(() => null);
        if (user) {
          label = user.username;
          description = `(${user.tag})`;
        } else if (db.tutorProfiles?.[tid]?.username) {
          label = db.tutorProfiles[tid].username;
          if (db.tutorProfiles[tid].tag) description = `(${db.tutorProfiles[tid].tag})`;
        }
      }
    } catch (e) {
      // Best-effort label lookup only; fall back to stored IDs/usernames when Discord fetches fail.
    }
    const option = {
      label: (label || `User ${tid}`).substring(0, 100),
      value: String(tid).substring(0, 100)
    };
    if (description) option.description = description.substring(0, 100);
    options.push(option);
  }
  return options;
}

async function buildCloseFlowComponents(guild, code, ticket, { tutorPage = 0, subjectPage = 0 } = {}) {
  const hiredSelect = new StringSelectMenuBuilder()
    .setCustomId(`close_ticket_select|${code}|hired`)
    .setPlaceholder('Did the student hire a tutor?')
    .addOptions([
      { label: 'No', value: 'no', description: 'Student did not hire a tutor' },
      { label: 'Yes, hired tutor', value: 'yes', description: 'Student hired a tutor' }
    ]);

  const tutorSelect = buildPaginatedSelectMenu({
    baseCustomId: `close_ticket_select|${code}|tutor`,
    placeholder: 'Choose tutor (if hired)',
    options: await buildTutorSelectOptions(guild, getAllTutorIds(), { includeNoneOption: true, noneLabel: 'No tutor selected', noneDescription: 'Leave tutor unassigned for this closeout' }),
    page: tutorPage
  });

  const selectedTutorId = ticket?._closeFlowTemp?.hiredTutorId;
  const tutorSubjects = selectedTutorId && selectedTutorId !== 'none'
    ? Object.entries(db.subjectTutors || {})
        .filter(([, tutors]) => tutors.includes(selectedTutorId))
        .map(([subject]) => subject)
    : null;
  const baseSubjectOptions = tutorSubjects && tutorSubjects.length > 0
    ? buildSubjectSelectOptions(tutorSubjects)
    : buildSubjectSelectOptions(db.subjects || []);
  const subjectOptions = [];
  if (!selectedTutorId || selectedTutorId === 'none' || (tutorSubjects && tutorSubjects.includes(ticket.subject))) {
    subjectOptions.push({ label: 'Use ticket subject', value: 'ticket_subject', description: `Ticket subject: ${ticket.subject}`.substring(0, 100) });
  }
  subjectOptions.push(...baseSubjectOptions);

  const subjectSelect = buildPaginatedSelectMenu({
    baseCustomId: `close_ticket_select|${code}|subject`,
    placeholder: tutorSubjects && tutorSubjects.length > 0 ? 'Choose subject this tutor teaches' : 'Choose subject for assignment (if hired)',
    options: subjectOptions,
    page: subjectPage
  });

  return [
    new ActionRowBuilder().addComponents(hiredSelect),
    new ActionRowBuilder().addComponents(tutorSelect),
    new ActionRowBuilder().addComponents(subjectSelect),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`open_close_modal|${code}`).setLabel('Provide reason and close').setStyle(ButtonStyle.Danger)
    )
  ];
}


// Try to fetch a user but fail fast (timeout) to avoid interaction timeouts
// NOTE: We avoid network fetches during modal construction to prevent interaction timeouts.
// Use cached guild members / users synchronously when building selects.

function loadDB() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      db = Object.assign(db, parsed);
      // Migrate legacy single keyword trigger/response into the new keyword list.
      const migratedKeywords = normalizeKeywordAutomations(db.keywordAutomations);
      const legacyKeyword = String(db.keywordTrigger || '').trim();
      const legacyResponse = String(db.keywordResponse || '').trim();
      let keywordMigrationChanged = false;
      if (legacyKeyword && legacyResponse) {
        migratedKeywords.push({
          keyword: legacyKeyword.substring(0, 100),
          response: legacyResponse.substring(0, 2000),
          createdAt: Date.now(),
          createdBy: null
        });
        keywordMigrationChanged = true;
      }
      db.keywordAutomations = normalizeKeywordAutomations(migratedKeywords);
      delete db.keywordTrigger;
      delete db.keywordResponse;
      if (keywordMigrationChanged) saveDB();
      // Migrate old delayDays to delaySeconds if needed
if (db.reviewConfig && db.reviewConfig.delayDays && !db.reviewConfig.delaySeconds) {
  db.reviewConfig.delaySeconds = db.reviewConfig.delayDays * 24 * 60 * 60;
  delete db.reviewConfig.delayDays;
  saveDB();
}
      // Normalize any literal '#tutors-link-policies' entries to the configured channel mention
      try {
        const policyMention = TUTOR_POLICIES_CHANNEL_ID ? `<#${TUTOR_POLICIES_CHANNEL_ID}>` : null;
        let migrated = false;
        if (policyMention) {
          if (db.initMessage && typeof db.initMessage === 'string' && db.initMessage.includes('#tutors-link-policies')) {
            db.initMessage = db.initMessage.split('#tutors-link-policies').join(policyMention);
            migrated = true;
          }
        }
        if (migrated) saveDB();
      } catch (e) { /* migration shouldn't crash startup */ }
    } catch (e) {
      console.error('Failed to load DB', e);
    }
  } else if (!appwriteClient.isConfigured()) {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); } catch (e) { console.warn('cannot write DB', e); }
  }
}

async function cleanupLegacyInactivityTickets() {
  try {
    const now = Date.now();
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

    for (const [code, ticket] of Object.entries(db.tickets || {})) {
      try {
        if (!ticket || !ticket.createdAt) continue;
        if (ticket.inactivityClosedAt || ticket.inactivityNotified) continue;
        const hasStudentMessage = (ticket.messages || []).some(m => m.who === 'Student');
        if (hasStudentMessage) continue;
        if (now - ticket.createdAt < TWENTY_FOUR_HOURS) continue;

        ticket.inactivityClosedAt = now;
        ticket.inactivityNotified = true;
        saveDB();
        await appwriteClient.syncDB(db).catch(err => {
          console.warn(`ticket inactivity cleanup: failed to persist handled flag for ${code}`, err);
        });

        try {
          const ch = await client.channels.fetch(ticket.ticketChannelId).catch(() => null);
          if (ch) {
            await ch.send('This ticket has been automatically closed due to inactivity (no message received within 24 hours).').catch(() => {});
            await ch.delete('Auto-closed: no student message within 24 hours').catch(async (err) => {
              console.warn(`ticket inactivity cleanup: channel delete failed for ${code}`, err);
              try { await ch.permissionOverwrites.edit(ticket.studentId, { ViewChannel: false, SendMessages: false }).catch(() => {}); } catch (ee) {}
            });
          }
        } catch (e) { console.warn(`ticket inactivity cleanup: channel cleanup failed for ${code}`, e); }

        delete db.tickets[code];
        saveDB();
        await appwriteClient.syncDB(db).catch(err => {
          console.warn(`ticket inactivity cleanup: failed to persist removal for ${code}`, err);
        });
      } catch (e) {
        console.warn(`ticket inactivity cleanup: error for ticket ${code}`, e);
      }
    }
  } catch (e) {
    console.warn('legacy ticket inactivity cleanup error', e);
  }
}

async function initializeDB() {
  let shouldSeedAppwrite = false;
  if (appwriteClient.isConfigured()) {
    console.log('[BotDB] Configured; starting initial load.');
    try {
      const appwriteData = await appwriteClient.loadDB();
      if (appwriteData && Object.keys(appwriteData).length > 0) {
        Object.assign(db, appwriteData);
        console.log('[BotDB] Initial load completed.');
        return;
      }
      console.log('[BotDB] Initial load returned no records; checking local bootstrap data.');
      shouldSeedAppwrite = true;
    } catch (e) {
      console.warn('[BotDB] Initial load failed, falling back to local data.json:', e.message);
      shouldSeedAppwrite = true;
    }
  } else {
    console.log('[BotDB] Not configured; running in local JSON mode.');
  }

  loadDB();

  if (shouldSeedAppwrite && appwriteClient.isConfigured()) {
    scheduleAppwriteSync();
  }
}

await initializeDB();

function normalizeKeywordAutomations(rawEntries) {
  const list = Array.isArray(rawEntries) ? rawEntries : [];
  const seen = new Map();

  for (const entry of list) {
    const keyword = String(entry?.keyword || '').trim();
    const response = String(entry?.response || '').trim();
    if (!keyword || !response) continue;

    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;

    seen.set(key, {
      keyword: keyword.substring(0, 100),
      response: response.substring(0, 2000),
      createdAt: Number(entry?.createdAt) || Date.now(),
      createdBy: entry?.createdBy ? String(entry.createdBy) : null
    });
  }

  return [...seen.values()];
}

async function formatUserLabel(guild, userId) {
  const id = String(userId || '').trim();
  if (!id) return '(unknown)';

  try {
    const cachedMember = guild?.members?.cache?.get(id) || null;
    if (cachedMember?.user) {
      const name = cachedMember.displayName || cachedMember.user.username || id;
      return `${name} (<@${id}>)`;
    }

    if (guild?.members?.fetch) {
      const fetchedMember = await guild.members.fetch(id).catch(() => null);
      if (fetchedMember?.user) {
        const name = fetchedMember.displayName || fetchedMember.user.username || id;
        return `${name} (<@${id}>)`;
      }
    }

    const cachedUser = client.users.cache.get(id) || null;
    if (cachedUser) {
      return `${cachedUser.username || id} (<@${id}>)`;
    }

    const fetchedUser = await client.users.fetch(id).catch(() => null);
    if (fetchedUser) {
      return `${fetchedUser.username || id} (<@${id}>)`;
    }
  } catch (e) {}

  return `<@${id}>`;
}

// Helper function to split long messages into chunks that fit Discord's 2000 character limit
function splitMessage(content, maxLength = 2000) {
  if (content.length <= maxLength) return [content];
  const chunks = [];
  let currentChunk = '';
  const lines = content.split('\n');
  
  for (const line of lines) {
    // If a single line is too long, split it
    if (line.length > maxLength) {
      if (currentChunk) {
        chunks.push(currentChunk);
        currentChunk = '';
      }
      // Split the long line
      for (let i = 0; i < line.length; i += maxLength) {
        chunks.push(line.substring(i, i + maxLength));
      }
    } else if (currentChunk.length + line.length + 1 > maxLength) {
      // Current chunk would be too long, save it and start new one
      chunks.push(currentChunk);
      currentChunk = line;
    } else {
      // Add line to current chunk
      currentChunk += (currentChunk ? '\n' : '') + line;
    }
  }
  
  if (currentChunk) chunks.push(currentChunk);
  return chunks;
}

// Safe reply helper for component/select interactions to avoid Unknown interaction errors
async function safeReply(interaction, options) {
  try {
    // Prefer update if possible (edits original message)
    if (!interaction.replied && !interaction.deferred && typeof interaction.update === 'function' && interaction.message) {
      try { await interaction.update(options); return; } catch (e) { /* fallthrough */ }
    }

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply(options);
    } else {
      await interaction.followUp(options);
    }
  } catch (e) {
    // If everything fails (likely interaction token expired), log and stop.
    console.warn('safeReply failed', e);
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel]
});

await cleanupLegacyInactivityTickets();

// helpers

async function sendReviewPage(tutorId, page = 0, sortMethod = 'newest') {
    const tutorProfile = db.tutorProfiles[tutorId];
    if (!tutorProfile || !tutorProfile.reviews || tutorProfile.reviews.length === 0) {
        return { content: 'No reviews available for this tutor.' };
    }
    
    // Sort reviews
    let reviews = [...tutorProfile.reviews];
    switch (sortMethod) {
        case 'newest':
            reviews.sort((a, b) => b.submittedAt - a.submittedAt);
            break;
        case 'oldest':
            reviews.sort((a, b) => a.submittedAt - b.submittedAt);
            break;
        case 'highest':
            reviews.sort((a, b) => b.rating - a.rating);
            break;
        case 'lowest':
            reviews.sort((a, b) => a.rating - b.rating);
            break;
    }
    
    // Paginate
    const itemsPerPage = 5;
    const totalPages = Math.ceil(reviews.length / itemsPerPage);
    const start = page * itemsPerPage;
    const end = start + itemsPerPage;
    const pageReviews = reviews.slice(start, end);
    
    // Create embed
    const embed = new EmbedBuilder()
        .setTitle(`Reviews for Tutor`)
        .setDescription(`Showing ${start + 1}-${Math.min(end, reviews.length)} of ${reviews.length} reviews`)
        .addFields({ name: 'Sort Method', value: sortMethod, inline: true })
        .addFields({ name: 'Page', value: `${page + 1}/${totalPages}`, inline: true })
        .addFields({ name: 'Average Rating', value: tutorProfile.rating?.avg ? `${tutorProfile.rating.avg.toFixed(1)} ⭐` : 'No rating', inline: true })
        .setTimestamp();
    
    // Add review fields
    for (let i = 0; i < pageReviews.length; i++) {
        const review = pageReviews[i];
        const date = `<t:${Math.floor(review.submittedAt / 1000)}:R>`;
        const stars = '⭐'.repeat(review.rating) + '☆'.repeat(5 - review.rating);
        embed.addFields({
            name: `Review ${start + i + 1} ${stars}`,
            value: `${review.text.substring(0, 200)}${review.text.length > 200 ? '...' : ''}\n*${date}*`,
            inline: false
        });
    }
    
    // Create buttons
    const buttons = [];
    
    // Previous button
    if (page > 0) {
        buttons.push(new ButtonBuilder()
            .setCustomId(`review_prev|${tutorId}|${page}|${sortMethod}`)
            .setLabel('⬅️ Previous')
            .setStyle(ButtonStyle.Secondary));
    }
    
    // Next button
    if (page < totalPages - 1) {
        buttons.push(new ButtonBuilder()
            .setCustomId(`review_next|${tutorId}|${page}|${sortMethod}`)
            .setLabel('Next ➡️')
            .setStyle(ButtonStyle.Secondary));
    }
    
    // Sort select menu
    const sortOptions = [
        { label: 'Newest First', value: 'newest' },
        { label: 'Oldest First', value: 'oldest' },
        { label: 'Highest Rated', value: 'highest' },
        { label: 'Lowest Rated', value: 'lowest' }
    ];
    
    const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`review_sort|${tutorId}|${page}`)
    .setPlaceholder('Sort by...')
    .addOptions(sortOptions.map(opt => new StringSelectMenuOptionBuilder()
        .setLabel(opt.label)
        .setValue(opt.value)
        .setDefault(opt.value === sortMethod)
    ));
    
    const rows = [];
    if (buttons.length > 0) {
        rows.push(new ActionRowBuilder().addComponents(buttons));
    }
    rows.push(new ActionRowBuilder().addComponents(selectMenu));
    
    return {
        embeds: [embed],
        components: rows
    };
}

// Helper function to update review threads for a tutor when new reviews are added
async function updateReviewThreadsForTutor(tutorId) {
    return null;
}

function generateTicketNumber() {
  const id = db.nextTicketId || 1;
  db.nextTicketId = id + 1;
  saveDB();
  return String(id);
}

function getStaffRoleIds() {
  const base = (STAFF_ROLE_ID || '').split(',').map(s => s.trim()).filter(Boolean);
  const extras = [process.env.MANAGER_ROLE_ID, process.env.ISOFUSIE_ROLE_ID].filter(Boolean).map(s => String(s).trim());
  return Array.from(new Set([...base, ...extras]));
}

function getAlertRoleIds() {
  const base = (STAFF_ROLE_ID || '').split(',').map(s => s.trim()).filter(Boolean);
  const extras = [BOT_DEVELOPER_ROLE_ID, ISOFUSIE_ROLE_ID].filter(Boolean).map(s => String(s).trim());
  return Array.from(new Set([...base, ...extras]));
}

function isStaff(member) {
  if (!member) return false;
  const staffRoleIds = getStaffRoleIds();
  for (const rid of staffRoleIds) {
    if (member.roles?.cache?.has && member.roles.cache.has(rid)) return true;
  }
  return false;
}

/**
 * notifyStaffError(err, source, context)
 * - err: Error or object
 * - source: short string describing module or location
 * - context: optional, interaction or message object to extract user id / command
 *
 * Defensive, best-effort, does not throw
 */
async function notifyStaffError(err, source = '(unknown)', context = null) {
  try {
    const staffChatId = process.env.STAFF_CHAT_ID || STAFF_CHAT_ID;
    if (!staffChatId) {
      console.warn('notifyStaffError: no STAFF_CHAT_ID configured');
      return;
    }

    let raw = '';
    if (err instanceof Error) raw = err.stack || err.message || String(err);
    else {
      try { raw = JSON.stringify(err, Object.getOwnPropertyNames(err)); } catch { raw = String(err); }
    }

    // Truncate to 1000 chars to leave room for code block markers (```) and ensure it fits in embed field (1024 char limit)
    const safe = String(raw).replace(/```/g, "'''").substring(0, 1000);

    let userId = '';
    const extra = [];
    try {
      if (context) {
        if (context.user) userId = context.user?.id || '';
        else if (context.author) userId = context.author?.id || '';
        else if (context.member && context.member.user) userId = context.member.user.id || '';
        if (context && context.commandName) extra.push(`command: ${context.commandName}`);
        if (context && context.customId) extra.push(`customId: ${context.customId}`);
        if (context && context.channelId) extra.push(`channelId: ${context.channelId}`);
      }
    } catch (e) { /* ignore */ }

    const mentionText = getAlertRoleIds().length ? getAlertRoleIds().map(r => `<@&${r}>`).join(' ') : '';

    // Ensure the field value doesn't exceed 1024 characters (Discord limit)
    const errorFieldValue = `\`\`\`\n${safe}\n\`\`\``;
    const finalErrorValue = errorFieldValue.length > 1024 ? errorFieldValue.substring(0, 1021) + '...' : errorFieldValue;

    const embed = new EmbedBuilder()
      .setTitle('Bot Error Alert')
      .setDescription(`**Source:** ${String(source).substring(0, 250)}\n${userId ? `**User ID:** ${userId}\n` : ''}${extra.length ? `**Context:** ${extra.join(', ')}\n` : ''}`)
      .addFields({ name: 'Error (truncated)', value: finalErrorValue })
      .setTimestamp();

    // try fetch channel
    let ch = null;
    try {
      const g = client.guilds.cache.get(GUILD_ID) || (GUILD_ID ? await client.guilds.fetch(GUILD_ID).catch(() => null) : null);
      if (g) {
        try { ch = await g.channels.fetch(staffChatId).catch(() => null); } catch { ch = null; }
      }
    } catch (e) { ch = null; }

    if (!ch) {
      try { ch = await client.channels.fetch(staffChatId).catch(() => null); } catch (e) { ch = null; }
    }
    if (!ch) {
      console.warn('notifyStaffError: staff channel not found', staffChatId);
      return;
    }

    try {
      await ch.send({ content: mentionText || undefined, embeds: [embed] }).catch(() => {});
    } catch (e) {
      console.warn('notifyStaffError send failed', e);
    }
  } catch (e) {
    console.warn('notifyStaffError internal failure', e);
  }
}

// register modmail, pass notifier
try {
  initModmail({
    client,
    db,
    saveDB,
    config: {
      MODMAIL_CATEGORY_ID,
      MODMAIL_TRANSCRIPTS_CHANNEL_ID,
      MODMAIL_PURPOSE_CATEGORIES: db.modmail?.config?.purposeCategories || {}
    },
    notifyError: async (err, ctx = {}) => {
      try {
        await notifyStaffError(err, ctx.module || 'modmail', ctx);
      } catch (notifyErr) {
        console.warn('notifyStaffError failed from modmail notifyError', notifyErr);
      }
    }
  });
} catch (e) {
  console.warn('initModmail threw', e);
  try { notifyStaffError(e, 'initModmail'); } catch (err) { console.warn('notify staff failed for initModmail', err); }
}

// register Alvey AI assistant
try {
  initAIAssistant({
    client,
    db,
    saveDB,
    createEnquiryTicket: createEnquiryTicketFromInteraction,
    notifyError: async (err, ctx = {}) => {
      try {
        await notifyStaffError(err, ctx.module || 'ai-assistant', ctx.interaction || ctx.message || ctx);
      } catch (notifyErr) {
        console.warn('notifyStaffError failed from ai-assistant notifyError', notifyErr);
      }
    }
  });
} catch (e) {
  console.warn('initAIAssistant threw', e);
  try { notifyStaffError(e, 'initAIAssistant'); } catch (err) { console.warn('notify staff failed for initAIAssistant', err); }
}

// In-memory map: tutorThreadId -> error Message object (one error message at a time per thread)
const threadErrorMessages = new Map();
// How long (ms) the internal-note acknowledgment stays before auto-deleting
const INTERNAL_NOTE_ACK_TIMEOUT_MS = 10000;

// centralised sticky repost helper, given a channel object, with a short lock to prevent duplicate reposts
const _stickyLocks = new Set();
async function repostStickyInChannel(channel) {
  if (!channel || !db.sticky) return null;
  const lockKey = `sticky:${channel.id}`;
  if (_stickyLocks.has(lockKey)) return null;
  _stickyLocks.add(lockKey);
  try {
    // delete old sticky if present
    if (db.sticky.messageId) {
      try {
        const prev = await channel.messages.fetch(db.sticky.messageId).catch(() => null);
        if (prev && prev.deletable) await prev.delete().catch(() => {});
      } catch (e) {}
    }
    const embed = new EmbedBuilder().setTitle(db.sticky.title || undefined).setDescription(db.sticky.body || '').setTimestamp();
    const color = db.sticky.color || db.defaultEmbedColor || null;
    if (color) {
      try { embed.setColor(String(color)); } catch (e) {}
    }
    const sent = await channel.send({ embeds: [embed] }).catch(() => null);
    if (sent) {
      db.sticky.messageId = sent.id;
      saveDB();
      return sent;
    }
  } catch (e) {
    console.warn('repostStickyInChannel failed', e);
    try { await notifyStaffError(e, 'repostStickyInChannel'); } catch (err) {}
  } finally {
    setTimeout(() => _stickyLocks.delete(lockKey), 1500);
  }
  return null;
}

// Post to tutors feed, create thread, update ticket object
async function postToTutorsFeed(guild, ticketCode, subject, firstMessage, ticket) {
  const tutorsFeed = await guild.channels.fetch(TUTORS_FEED_CHANNEL_ID).catch(() => null);
  if (!tutorsFeed) throw new Error('Tutors feed channel not found');

  const tutorIds = db.subjectTutors[subject] || [];
  const mentionText = tutorIds.length ? '\n\nNotifying: ' + tutorIds.map(id => `<@${id}>`).join(' ') : '';
  const content = `New request, Subject: **${subject}** (ticket **${ticketCode}**)\nFirst message: ${firstMessage}${mentionText}`;

  const tutorsMessage = await tutorsFeed.send({ content }).catch(err => { throw err; });
  const threadName = `Enquiry ${subject || ticketCode}`;
  const thread = await tutorsMessage.startThread({ name: threadName.substring(0, 100), autoArchiveDuration: 1440 }).catch(() => null);
    if (thread) {
      ticket.tutorThreadId = thread.id;
      await thread.send(
      `📌 **How to message the student in this thread:**\n` +
      `• Messages you send here are **automatically forwarded** to the student.\n` +
      `• Prefix a message with \`=\` to keep it as an **internal note** (e.g. \`=only tutors see this\`) — it will **not** be sent to the student.`
    ).catch(() => {});
  }
  ticket.tutorMessageId = tutorsMessage.id;
  saveDB();
  return { tutorsMessage, thread };
}

// Grant tutor access
async function grantTutorAccess(userId) {
  const chIds = [
    TUTORS_FEED_CHANNEL_ID,
    TUTOR_CHAT_CHANNEL_ID
  ].filter(Boolean);

  for (const chId of chIds) {
    try {
      const ch = await client.channels.fetch(chId).catch(() => null);
      if (!ch) { console.warn(`grantTutorAccess, channel ${chId} not found`); continue; }
      const guild = ch.guild;
      if (!guild) { console.warn(`grantTutorAccess, channel ${chId} has no guild`); continue; }

      try {
        await ch.permissionOverwrites.edit(guild.roles.everyone.id, { ViewChannel: false }).catch(() => {});
        for (const rid of getStaffRoleIds()) {
          await ch.permissionOverwrites.edit(rid, { ViewChannel: true, SendMessages: true }).catch(() => {});
        }
      } catch (e) {}

      let member = null;
      try { member = await guild.members.fetch(userId).catch(() => null); } catch (e) { member = null; }

      try {
        const target = member || String(userId);
        await ch.permissionOverwrites.edit(target, { ViewChannel: true, SendMessages: true });
        console.log(`grantTutorAccess: granted ${userId} on ${chId}`);
      } catch (err) {
        console.warn(`grantTutorAccess per-channel error for ${userId} on ${chId}`, err?.message || err);
        if (!member) {
          try {
            await ch.permissionOverwrites.edit(String(userId), { ViewChannel: true, SendMessages: true });
            console.log(`grantTutorAccess fallback by id: granted ${userId} on ${chId}`);
          } catch (err2) {
            console.warn(`grantTutorAccess fallback failed for ${userId} on ${chId}`, err2?.message || err2);
          }
        }
      }
    } catch (e) {
      console.warn('grantTutorAccess outer error', e);
    }
  }

  await syncTutorsLoungeCategoryAccess();
}

// Revoke tutor access and remove students assignment for that tutor
async function revokeTutorAccess(userId) {
  const chIds = [
    TUTORS_FEED_CHANNEL_ID,
    TUTOR_CHAT_CHANNEL_ID
  ].filter(Boolean);

  for (const chId of chIds) {
    try {
      const ch = await client.channels.fetch(chId).catch(() => null);
      if (!ch) { console.warn(`revokeTutorAccess, channel ${chId} not found`); continue; }
      const guild = ch.guild;
      if (!guild) { console.warn(`revokeTutorAccess, channel ${chId} has no guild`); continue; }

      try {
        const ow = ch.permissionOverwrites.resolve(String(userId));
        if (ow) {
          await ow.delete().catch((err) => { console.warn(`revokeTutorAccess failed to delete overwrite for ${userId} on ${chId}`, err?.message || err); });
          console.log(`revokeTutorAccess: removed overwrite for ${userId} on ${chId}`);
        } else {
          await ch.permissionOverwrites.edit(String(userId), { ViewChannel: false, SendMessages: false }).catch((err) => {
            console.warn(`revokeTutorAccess: set ViewChannel=false for ${userId} on ${chId}`, err?.message || err);
          });
          console.log(`revokeTutorAccess: set ViewChannel=false for ${userId} on ${chId}`);
        }
      } catch (err) {
        console.warn(`revokeTutorAccess per-channel error for ${userId} on ${chId}`, err?.message || err);
      }
    } catch (e) {
      console.warn('revokeTutorAccess outer error', e);
    }
  }

  // remove student assignments for this tutor
  try {
    for (const sid of Object.keys(db.studentAssignments || {})) {
      const asg = db.studentAssignments[sid];
      if (asg && String(asg.tutorId) === String(userId)) {
        delete db.studentAssignments[sid];
      }
    }
    if (db.tutorProfiles && db.tutorProfiles[userId]) {
      delete db.tutorProfiles[userId];
    }
    saveDB();
  } catch (e) {
    console.warn('revokeTutorAccess cleanup failed', e);
  }

  await syncTutorsLoungeCategoryAccess();
}

// register slash commands
async function registerCommands() {
  const restCommands = [
    {
      name: 'enquire',
      description: 'Create an enquiry ticket, choose a subject',
      options: [{ name: 'subject', description: 'Type the subject name', type: 3, required: true, autocomplete: true }]
    },
    {
      name: 'close',
      description: 'Close a ticket (staff only), opens a flow to capture reason and assignment',
      options: [
        { name: 'code', description: 'Ticket code to close', type: 3, required: true }
      ],
      default_member_permissions: PermissionFlagsBits.ManageMessages.toString()
    },
    {
      name: 'subject',
      description: 'Manage subjects (staff add/remove/list)',
      options: [
        { name: 'action', description: 'add, remove, or list', type: 3, required: true, choices: [{ name: 'add', value: 'add' }, { name: 'remove', value: 'remove' }, { name: 'list', value: 'list' }] },
        { name: 'subject', description: 'Subject name for add/remove', type: 3, required: false },
        { name: 'level', description: 'Filter by level (igcse, a_level, university, below_igcse, language, test_prep, other)', type: 3, required: false, choices: [
          { name: 'IGCSE', value: 'igcse' },
          { name: 'A Level', value: 'a_level' },
          { name: 'University', value: 'university' },
          { name: 'Below IGCSE', value: 'below_igcse' },
          { name: 'Language', value: 'language' },
          { name: 'Test Prep', value: 'test_prep' },
          { name: 'Other', value: 'other' }
        ]},
        { name: 'tutor-assigned', description: 'Filter by tutor assignment: yes = has tutor, no = no tutor, all = no filter', type: 3, required: false, choices: [{ name: 'yes', value: 'yes' }, { name: 'no', value: 'no' }, { name: 'all', value: 'all' }] }
      ],
      default_member_permissions: PermissionFlagsBits.ManageMessages.toString()
    },
    {
      name: 'tutor',
      description: 'Manage tutors or view info',
      options: [
        { name: 'add', description: 'Assign a tutor to a subject', type: 1, options: [
          { name: 'user', description: 'Mention or select the tutor user (e.g. @username)', type: 6, required: false },
          { name: 'subject', description: 'Subject for mapping (autocomplete shows subjects with tutors)', type: 3, required: false, autocomplete: true }
        ] },
        { name: 'remove', description: 'Remove a tutor from a subject', type: 1, options: [
          { name: 'user', description: 'Mention or select the tutor user (e.g. @username)', type: 6, required: false },
          { name: 'subject', description: 'Subject for mapping (autocomplete shows subjects with tutors)', type: 3, required: false, autocomplete: true }
        ] },
        { name: 'list', description: 'List tutors or tutor assignments', type: 1, options: [
          { name: 'subject', description: 'Filter by subject', type: 3, required: false, autocomplete: true }
        ] },
        { name: 'info', description: 'View a tutor profile', type: 1, options: [
          { name: 'user', description: 'Mention or select the tutor user (e.g. @username)', type: 6, required: false }
        ] },
        { name: 'notes', description: 'Edit tutor notes', type: 1, options: [
          { name: 'user', description: 'Mention or select the tutor user (e.g. @username)', type: 6, required: false }
        ] },
        { name: 'edit', description: 'Edit tutor contact info', type: 1, options: [
          { name: 'user', description: 'Mention or select the tutor user (e.g. @username)', type: 6, required: false }
        ] }
      ],
      default_member_permissions: PermissionFlagsBits.ManageMessages.toString()
    },
    {
      name: 'sticky',
      description: 'Create or edit the sticky welcome message in find-a-tutor',
      default_member_permissions: PermissionFlagsBits.ManageMessages.toString()
    },
    {
      name: 'embedcolor',
      description: 'Set default embed color hex e.g. #00ff00',
      options: [{ name: 'hex', description: 'Hex color, include #', type: 3, required: true }],
      default_member_permissions: PermissionFlagsBits.ManageMessages.toString()
    },
    { name: 'editinit', description: 'Open modal to edit the initial ticket message (staff only)', default_member_permissions: PermissionFlagsBits.ManageMessages.toString() },
    { name: 'help', description: 'Show available user commands' },
    { name: 'staffhelp', description: 'Show staff commands', default_member_permissions: PermissionFlagsBits.ManageMessages.toString() },
    {
      name: 'aichannel',
      description: 'Set the public channel where Alvey Assistant listens',
      options: [
        { name: 'set', description: 'Set Alvey Assistant channel', type: 1, options: [
          { name: 'channel', description: 'Public channel for Alvey Assistant mentions', type: 7, required: true, channel_types: [ChannelType.GuildText] }
        ] }
      ],
      default_member_permissions: PermissionFlagsBits.ManageMessages.toString()
    },
    { name: 'bumpleaderboard', description: 'Show the bump leaderboard - see who has bumped the server the most!' },
    // student & review commands
    { name: 'student', description: 'Manage student assignments', options: [
        { name: 'add', description: 'Add a student to a tutor', type: 1, options: [
          { name: 'student', type: 6, required: true, description: 'Student user' },
          { name: 'tutor', type: 6, required: true, description: 'Tutor user' },
          { name: 'subject', type: 3, required: false, description: 'Subject (optional)', autocomplete: true }
        ] },
        { name: 'remove', description: 'Remove a student from a tutor', type: 1, options: [
          { name: 'student', type: 6, required: true, description: 'Student user' },
          { name: 'tutor', type: 6, required: true, description: 'Tutor user' },
          { name: 'subject', type: 3, required: false, description: 'Subject (optional)', autocomplete: true }
        ] },
        { name: 'list', description: 'List student assignments', type: 1, options: [
          { name: 'tutor', type: 6, required: false, description: 'Filter by tutor' },
          { name: 'subject', type: 3, required: false, description: 'Filter by subject', autocomplete: true }
        ] }
      ], default_member_permissions: PermissionFlagsBits.ManageMessages.toString()
    },
    { name: 'keyword', description: 'Manage keyword auto-responses', options: [
        { name: 'set', description: 'Add or update a keyword response', type: 1, options: [
          { name: 'keyword', description: 'The word or phrase to watch for', type: 3, required: true },
          { name: 'response', description: 'The bot response to post when triggered', type: 3, required: true }
        ] },
        { name: 'list', description: 'View all keyword responses', type: 1 },
        { name: 'remove', description: 'Remove a keyword response', type: 1, options: [
          { name: 'keyword', description: 'The keyword to remove', type: 3, required: true }
        ] }
      ],
      default_member_permissions: PermissionFlagsBits.ManageMessages.toString()
    },
    { name: 'reviewreminder', description: 'Set review reminder delay in seconds', options: [
        { name: 'seconds', type: 3, required: true, description: 'Number of seconds to wait before sending review reminder' }
      ], default_member_permissions: PermissionFlagsBits.ManageMessages.toString()
    },
    {
      name: 'modmailmap',
      description: 'Set the modmail category for a purpose using a category picker',
      options: [
        { name: 'purpose', type: 3, required: true, description: 'Purpose to configure', choices: [
          { name: 'Default modmail category', value: 'default' },
          { name: 'Tutor Applications', value: 'tutor_application' },
          { name: 'Complaints & Suggestions', value: 'complaints_suggestions' },
          { name: 'Client Support', value: 'customer_service' },
          { name: 'Payments', value: 'payment' }
        ] },
        { name: 'category', type: 7, required: true, description: 'Select a Discord category', channel_types: [ChannelType.GuildCategory] }
      ],
      default_member_permissions: PermissionFlagsBits.ManageMessages.toString()
    },
    {
      name: 'seedsubjects',
      description: 'Seed IGCSE/GCSE and AS/AL subjects from the predefined channel list (staff only, idempotent)',
      options: [
        { name: 'dryrun', description: 'If true, show what would be added without saving', type: 5, required: false }
      ],
      default_member_permissions: PermissionFlagsBits.ManageMessages.toString()
    }
  ];

  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: restCommands });
    console.log('Commands registered');
  } catch (e) {
    console.error('Failed to register commands', e);
    try { await notifyStaffError(e, 'registerCommands'); } catch (err) {}
  }
}

client.once('ready', async () => {
  console.log(`Ready as ${client.user.tag}`);

  // Guild presence check — helps confirm the bot is still in the server
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    console.log(`Bot is in guild: ${guild.name} (${guild.id})`);
  } catch (e) {
    console.warn(`Bot is NOT in guild (or lacks access): ${GUILD_ID} — re-invite via Discord Developer Portal OAuth2 URL`);
  }

  await registerCommands();
  await syncTutorsLoungeCategoryAccess();
  try { client.user.setActivity('DM for ModMail', { type: 3 }); } catch (e) {}
});

// process handlers
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION', reason);
  try { notifyStaffError(reason, 'unhandledRejection'); } catch (e) { console.warn('notify failed', e); }
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION', err);
  try { notifyStaffError(err, 'uncaughtException'); } catch (e) { console.warn('notify failed', e); }
});

// --- Interaction handling ---
// We'll preserve original logic but add the new flows:
// - /close now starts a select + modal flow so staff can mark whether student hired a tutor, which tutor, subject, reason
// - /ad create modal has optional tutor text field (resolveTutorInput) and thread creation is supported in ad modal submit
client.on('interactionCreate', async (interaction) => {
  try {
    // Autocomplete handlers
    if (interaction.isAutocomplete() && interaction.commandName === 'enquire') {
      const focused = interaction.options.getFocused();
      const query = String(focused || '').toLowerCase();
      const choices = sortStringsCaseInsensitive(db.subjects || [])
        .filter(subject => !query || subject.toLowerCase().includes(query))
        .slice(0, 25)
        .map(subject => ({ name: subject, value: subject }));
      await interaction.respond(choices).catch(() => { /* Discord rejects stale autocomplete responses after the user keeps typing. */ });
      return;
    }

    if (interaction.isAutocomplete() && interaction.commandName === 'tutor') {
      const focused = interaction.options.getFocused();
      let action = null;
      try { action = interaction.options.getSubcommand(false); } catch (e) {}
      if (!action) action = interaction.options.getString('action');
      const userOpt = interaction.options.getUser('user');
      let subjects;
      if ((action === 'remove' || action === 'list') && userOpt) {
        // Only show subjects the selected tutor is assigned to
        subjects = Object.entries(db.subjectTutors || {})
          .filter(([, ids]) => ids.includes(userOpt.id))
          .map(([s]) => s);
      } else {
        // Show subjects that have at least one tutor assigned
        subjects = Object.entries(db.subjectTutors || {})
          .filter(([, ids]) => ids.length > 0)
          .map(([s]) => s);
      }
      const query = String(focused || '').toLowerCase();
      const choices = sortStringsCaseInsensitive(subjects)
        .filter(s => !query || s.toLowerCase().includes(query))
        .slice(0, 25)
        .map(s => ({ name: s, value: s }));
      await interaction.respond(choices).catch(() => { /* Discord rejects stale autocomplete responses after the user keeps typing. */ });
      return;
    }

    if (interaction.isAutocomplete() && interaction.commandName === 'student') {
      const focused = interaction.options.getFocused();
      const query = String(focused || '').toLowerCase();
      const choices = sortStringsCaseInsensitive(db.subjects || [])
        .filter(subject => !query || subject.toLowerCase().includes(query))
        .slice(0, 25)
        .map(subject => ({ name: subject, value: subject }));
      await interaction.respond(choices).catch(() => {});
      return;
    }
    
    // Log all modal submits at the top level
    if (interaction.isModalSubmit()) {
      console.log(`[INTERACTION] Modal submit received - customId: ${interaction.customId}, type: ${interaction.type}`);
    }
    
    // BUTTONS
    if (interaction.isButton()) {
      const custom = interaction.customId || '';

            // Leave a review button
      if (custom.startsWith('review_start|')) {
          const [, studentId, tutorId] = custom.split('|');
          
          // Verify the user clicking is the student
          if (interaction.user.id !== studentId) {
              return interaction.reply({ content: 'Only the student can leave a review for their tutor.', ephemeral: true }).catch(() => {});
          }
          
          // Create a modal for the review
          const modal = new ModalBuilder()
              .setCustomId(`review_modal|${studentId}|${tutorId}`)
              .setTitle('Leave a Review');
          
          // Rating input (1-5)
          const ratingInput = new TextInputBuilder()
              .setCustomId('review_rating')
              .setLabel('Rating (1-5 stars)')
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setPlaceholder('Enter a number from 1 to 5')
              .setMaxLength(1);
          
          // Review text
          const textInput = new TextInputBuilder()
              .setCustomId('review_text')
              .setLabel('Review Text')
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true)
              .setPlaceholder('Share your experience with this tutor...')
              .setMaxLength(1000);
          
          modal.addComponents(
              new ActionRowBuilder().addComponents(ratingInput),
              new ActionRowBuilder().addComponents(textInput)
          );
          
          await interaction.showModal(modal);
          return;
      }

            // Review approve or deny button
      if (custom.startsWith('approve_review|') || custom.startsWith('deny_review|')) {
          const [action, reviewId] = custom.split('|');
          const review = db.pendingReviews.find(r => r.id === reviewId);
          
          if (!review) return interaction.reply({ content: 'Review not found.', ephemeral: true }).catch(() => {});
          if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can moderate reviews.', ephemeral: true }).catch(() => {});
          
          // Remove from pending
          db.pendingReviews = db.pendingReviews.filter(r => r.id !== reviewId);
          
          if (action === 'approve_review') {
              // Add to tutor's profile
              const tutorProfile = db.tutorProfiles[review.tutorId] || { reviews: [], rating: { count: 0, avg: 0 } };
              if (!tutorProfile.reviews) tutorProfile.reviews = [];
              if (!tutorProfile.rating) tutorProfile.rating = { count: 0, avg: 0 };
              
              tutorProfile.reviews.push(review);
              
              // Update rating
              const oldCount = tutorProfile.rating.count;
              const oldAvg = tutorProfile.rating.avg;
              const newCount = oldCount + 1;
              const newAvg = ((oldAvg * oldCount) + review.rating) / newCount;
              
              tutorProfile.rating = { count: newCount, avg: newAvg };
              db.tutorProfiles[review.tutorId] = tutorProfile;
              saveDB();
              
              // Update review threads for this tutor
              try {
                  await updateReviewThreadsForTutor(review.tutorId);
              } catch (e) {
                  console.warn('Failed to update review threads', e);
              }
              
              // Notify tutor
              try {
                  const tutorUser = await client.users.fetch(review.tutorId).catch(() => null);
                  if (tutorUser) {
                      await tutorUser.send(`A student left you a ${'⭐'.repeat(review.rating)} star review!\n"${review.text.substring(0, 500)}"`);
                  }
              } catch (e) { console.warn('Failed to DM tutor about review', e); }
              
              await interaction.update({ 
                  content: `✅ Review approved and added to tutor's profile.`, 
                  embeds: [], 
                  components: [] 
              });
          } else {
              await interaction.update({ 
                  content: `❌ Review denied and removed.`, 
                  embeds: [], 
                  components: [] 
              });
          }
          
          saveDB();
          return;
      }

      // approve / deny buttons (unchanged except notifyStaffError on modal errors)
      if (custom.startsWith('approve|') || custom.startsWith('deny|')) {
        const [act, code] = custom.split('|');
        const ticket = db.tickets[code];
        if (!ticket) return interaction.reply({ content: 'Ticket not found.', ephemeral: true }).catch(() => {});
        if (!isStaff(interaction.member)) return safeReply(interaction, { content: 'Only staff can do this.', ephemeral: true });

        if (act === 'deny') {
          if (ticket.approved) {
            return interaction.reply({ content: `Ticket ${code} is already approved, you cannot deny it now.`, ephemeral: true }).catch(() => {});
          }
          if (interaction.replied || interaction.deferred) {
            return interaction.followUp({ content: 'Could not open deny modal, try again.', ephemeral: true }).catch(() => {});
          }
          const modal = new ModalBuilder().setCustomId(`deny_modal|${code}`).setTitle(`Deny ticket ${code}`);
          const reasonInput = new TextInputBuilder().setCustomId('deny_reason').setLabel('Reason for denial (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false);
          modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
          try { await interaction.showModal(modal); } catch (err) { console.error('showModal failed', err); try { notifyStaffError(err, 'interactionCreate showModal deny_modal', interaction); } catch {} try { await interaction.followUp({ content: 'Could not open deny modal, try again.', ephemeral: true }); } catch {} }
          return;
        }

        if (act === 'approve') {
          if (!db.tickets[code]) return interaction.reply({ content: `Ticket ${code} not found.`, ephemeral: true }).catch(() => {});
          if (ticket.approved) return interaction.reply({ content: `Ticket ${code} already approved.`, ephemeral: true }).catch(() => {});

          await interaction.reply({ content: `Approving ticket ${code} and notifying tutors...`, ephemeral: true }).catch(() => {});
          const guild = interaction.guild;

          // build firstMessage
          let firstMessageText = '(no message found)';
          if (ticket.messages && ticket.messages.length > 0) {
            const m = ticket.messages.find(x => x.who === 'Student') || ticket.messages[0];
            if (m) {
              if (m.text && m.text.trim().length > 0) firstMessageText = m.text;
              else if (m.attachments && m.attachments.length) firstMessageText = `Attachment(s): ${m.attachments.join(' ')}`;
            }
          } else {
            try {
              const ch = await guild.channels.fetch(ticket.ticketChannelId).catch(() => null);
              if (ch) {
                const fetched = await ch.messages.fetch({ limit: 50 }).catch(() => null);
                const studentMsg = fetched ? Array.from(fetched.values()).find(m => !m.author.bot && m.author.id === ticket.studentId) : null;
                if (studentMsg) {
                  if (studentMsg.content && studentMsg.content.trim().length > 0) firstMessageText = studentMsg.content;
                  else if (studentMsg.attachments && studentMsg.attachments.size) firstMessageText = `Attachment(s): ${Array.from(studentMsg.attachments.values()).map(a => a.url).join(' ')}`;
                }
              }
            } catch (e) { /* ignore */ }
          }

          try {
            // If this ticket has a selectedTutorId then grant that tutor access instead
            if (ticket.selectedTutorId) {
              const tutorId = ticket.selectedTutorId;
              try {
                const tchan = await interaction.guild.channels.fetch(ticket.ticketChannelId).catch(() => null);
                if (tchan) {
                  await tchan.permissionOverwrites.edit(tutorId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }).catch(() => {});
                  // Notify tutor via DM (best-effort)
                  try {
                    const tutorUser = await client.users.fetch(tutorId).catch(() => null);
                    if (tutorUser) {
                      await tutorUser.send(`You were selected for ticket ${code} about ${ticket.subject}. Please join the channel <#${ticket.ticketChannelId}> to respond (ticket ${code}).`).catch(() => {});
                    }
                  } catch (e) {}
                  await tchan.send('Ticket approved by staff, selected tutor notified.').catch(() => {});
                }
              } catch (e) { console.warn('failed to grant selected tutor access', e); }

              ticket.approved = true;
              if (ticket.awaitingApproval) delete ticket.awaitingApproval;
              saveDB();
              await interaction.editReply({ content: `Ticket ${code} approved, selected tutor notified.` }).catch(() => {});
            } else {
              await postToTutorsFeed(interaction.guild, code, ticket.subject, firstMessageText, ticket);
              ticket.approved = true;
              if (ticket.awaitingApproval) delete ticket.awaitingApproval;
              saveDB();
              try {
                const tchan = await interaction.guild.channels.fetch(ticket.ticketChannelId).catch(() => null);
                if (tchan) await tchan.send('Ticket approved by staff, tutors notified.').catch(() => {});
              } catch (e) {}
              await interaction.editReply({ content: `Ticket ${code} approved, tutors notified.` }).catch(() => {});
            }
          } catch (e) {
            console.error('approve flow failed', e);
            try { await notifyStaffError(e, 'approve flow', interaction); } catch (err) {}
            try { await interaction.editReply({ content: `Failed to notify tutors for ${code}.`, ephemeral: true }); } catch {}
          }
          return;
        }
      }

      // Review Redact button
      if (custom.startsWith('redact_review|')) {
          const reviewId = custom.split('|')[1];
          const review = db.pendingReviews.find(r => r.id === reviewId);
          
          if (!review) return interaction.reply({ content: 'Review not found.', ephemeral: true }).catch(() => {});
          if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can redact reviews.', ephemeral: true }).catch(() => {});
          
          const modal = new ModalBuilder()
              .setCustomId(`redact_review_modal|${reviewId}`)
              .setTitle('Redact Review Text');
          
          const textInput = new TextInputBuilder()
              .setCustomId('redacted_text')
              .setLabel('Redacted Review Text')
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true)
              .setValue(review.text)
              .setPlaceholder('Edit the review to remove personal information...')
              .setMaxLength(1000);
          
          modal.addComponents(new ActionRowBuilder().addComponents(textInput));
          
          await interaction.showModal(modal);
          return;
      }

      // Add these button handlers in the button interaction section
      if (custom.startsWith('review_prev|') || custom.startsWith('review_next|')) {
          const [action, tutorId, currentPage, sortMethod] = custom.split('|');
          const page = parseInt(currentPage) || 0;
          const newPage = action === 'review_prev' ? page - 1 : page + 1;

          try {
            const messageData = await sendReviewPage(tutorId, newPage, sortMethod);
            if (messageData) {
              await interaction.update(messageData).catch(() => interaction.deferUpdate().catch(() => {}));
            } else {
              await interaction.deferUpdate().catch(() => {});
            }
          } catch (e) {
            console.error('Failed to paginate reviews via buttons', e);
            try { await notifyStaffError(e, 'review pagination button', interaction); } catch (err) {}
            await interaction.deferUpdate().catch(() => {});
          }
          return;
      }

      // FIX: Add the missing button handler for opening the close modal
      if (custom.startsWith('open_close_modal|')) {
        const code = custom.split('|')[1];
        console.log(`[OPEN CLOSE MODAL] Button clicked for ticket ${code}`);
        const ticket = db.tickets[code];
        if (!ticket) {
          console.log(`[OPEN CLOSE MODAL] Ticket ${code} not found`);
          return interaction.reply({ content: 'Ticket not found.', ephemeral: true }).catch(() => {});
        }
        if (!isStaff(interaction.member)) {
          console.log(`[OPEN CLOSE MODAL] User ${interaction.user.id} is not staff`);
          return interaction.reply({ content: 'Only staff can do this.', ephemeral: true }).catch(() => {});
        }
        
        // Check if selections were made
        if (!ticket._closeFlowTemp) {
          console.log(`[OPEN CLOSE MODAL] No temp data found for ticket ${code}`);
          return interaction.reply({ content: 'Please make selections first before providing a reason.', ephemeral: true }).catch(() => {});
        }
        
        console.log(`[OPEN CLOSE MODAL] Temp data for ticket ${code}:`, JSON.stringify(ticket._closeFlowTemp));
        
        // Validate tutor teaches the selected subject
        const temp = ticket._closeFlowTemp;
        if (temp.hired === 'yes' && temp.hiredTutorId && temp.hiredTutorId !== 'none' && temp.assignedSubject) {
          const selectedSubject = temp.assignedSubject === 'ticket_subject' ? ticket.subject : temp.assignedSubject;
          const tutorSubjects = [];
          for (const [subj, tutors] of Object.entries(db.subjectTutors)) {
            if (tutors.includes(temp.hiredTutorId)) {
              tutorSubjects.push(subj);
            }
          }
          
          if (!tutorSubjects.includes(selectedSubject)) {
            return interaction.reply({ content: `Error: This tutor does not teach ${selectedSubject}. Please select a different tutor or subject.`, ephemeral: true }).catch(() => {});
          }
        }
        
        // Open modal for close reason
        const modal = new ModalBuilder()
          .setCustomId(`close_ticket_modal|${code}`)
          .setTitle(`Close Ticket ${code}`);
        
        const reasonInput = new TextInputBuilder()
          .setCustomId('close_reason')
          .setLabel('Reason for closing')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setPlaceholder('Enter the reason for closing this ticket...');
        
        modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
        
        try {
          console.log(`[OPEN CLOSE MODAL] Attempting to show modal for ticket ${code}`);
          await interaction.showModal(modal);
          console.log(`[OPEN CLOSE MODAL] Modal shown successfully for ticket ${code}`);
        } catch (err) {
          console.error('[OPEN CLOSE MODAL] showModal failed', err);
          try { notifyStaffError(err, 'open_close_modal showModal', interaction); } catch (e) {}
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: 'Could not open modal, try again.', ephemeral: true }).catch(() => {});
          }
        }
        return;
      }
    } // Close button block
    
    // MODAL SUBMITS and select menus handling etc
    if (interaction.isModalSubmit()) {
      console.log(`[MODAL SUBMIT] First block reached, customId: ${interaction.customId}`);
      // deny modal flow unchanged
      if (interaction.customId && interaction.customId.startsWith('deny_modal|')) {
        console.log(`[MODAL SUBMIT] First block - handling deny_modal`);
        // same code as original deny flow, but with notifyStaffError on catches
        const code = interaction.customId.split('|')[1];
        const ticket = db.tickets[code];
        if (!ticket) return interaction.reply({ content: 'Ticket not found.', ephemeral: true }).catch(() => {});
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can deny tickets.', ephemeral: true }).catch(() => {});

        if (ticket.approved) {
          try {
            if (!interaction.replied && !interaction.deferred) await interaction.deferReply({ ephemeral: true }).catch(() => {});
            await interaction.editReply({ content: `Ticket ${code} was approved meanwhile, deny cancelled.`, ephemeral: true });
          } catch (e) {
            try { await interaction.followUp({ content: `Ticket ${code} was approved meanwhile, deny cancelled.`, ephemeral: true }); } catch {}
          }
          return;
        }

        await interaction.deferReply({ ephemeral: true }).catch(() => {});
        const reason = interaction.fields.getTextInputValue('deny_reason') || '(no reason provided)';

        // build transcript using Discord timestamp format
        const lines = [];
        lines.push(`Transcript for ticket ${code}`);
        lines.push(`Subject: ${ticket.subject}`);
        lines.push(`Student ID: ${ticket.studentId}`);
        lines.push(`Denied by: ${interaction.user.tag}`);
        lines.push(`Reason: ${reason}`);
        lines.push('----------------------------------');
        for (const m of ticket.messages || []) {
          const when = `<t:${Math.floor(m.at / 1000)}:f>`;
          let row = `[${when}] ${m.who}: ${m.text || ''}`;
          if (m.attachments && m.attachments.length) row += `\nAttachments: ${m.attachments.join(' ')}`;
          lines.push(row);
        }
        lines.push('----------------------------------\nEnd of transcript');

        // post transcript
        try {
          const transcriptsChannel = await interaction.guild.channels.fetch(TRANSCRIPTS_CHANNEL_ID).catch(() => null);
          if (transcriptsChannel) {
            const fullTranscript = lines.join('\n');
            const chunks = splitMessage(fullTranscript, 2000);
            
            // Send transcript in chunks
            for (let i = 0; i < chunks.length; i++) {
              await transcriptsChannel.send(chunks[i]).catch((err) => {
                console.warn('Failed to send transcript chunk', err);
              });
              // Small delay between chunks to avoid rate limiting (only if not last chunk)
              if (i < chunks.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 100));
              }
            }
            
            // Send attachments separately
            for (const m of ticket.messages || []) {
              if (m.attachments && m.attachments.length) {
                for (const url of m.attachments) {
                  try { await transcriptsChannel.send({ content: url }).catch(() => {}); } catch (e) {}
                }
              }
            }
          } else console.warn('Transcripts channel not found');
        } catch (e) { console.warn('posting transcript failed', e); try { notifyStaffError(e, 'deny_modal post transcript', interaction); } catch (err) {} }

        // DM student
        try {
          const studentUser = await client.users.fetch(ticket.studentId).catch(() => null);
          if (studentUser) {
            const dmText = `Your enquiry (${code}) about ${ticket.subject} was denied by staff.\nReason: ${reason}\nIf you think this was a mistake, please open a new enquiry with more details.`;
            await studentUser.send(dmText).catch(() => { console.warn('could not DM student'); });
          }
        } catch (e) { console.warn('DM student failed', e); try { notifyStaffError(e, 'deny_modal DM student', interaction); } catch (err) {} }

        // Delete or hide channel
        try {
          const guild = interaction.guild;
          const ticketChannel = await guild.channels.fetch(ticket.ticketChannelId).catch(() => null);
          if (ticketChannel) {
            await ticketChannel.send('Ticket denied by staff, closing now.').catch(() => {});
            await ticketChannel.delete('Denied by staff, transcript saved').catch(async (err) => {
              console.warn('delete failed, trying hide:', err);
              try { await ticketChannel.permissionOverwrites.edit(ticket.studentId, { ViewChannel: false, SendMessages: false }).catch(() => {}); } catch (e) { console.warn('hide also failed', e); }
            });
          }
        } catch (e) { console.warn('ticket channel deletion/hide failed', e); try { notifyStaffError(e, 'deny_modal channel finalize', interaction); } catch (err) {} }

        // Archive tutors thread
        try {
          if (ticket.tutorThreadId) {
            const thread = await interaction.guild.channels.fetch(ticket.tutorThreadId).catch(() => null);
            if (thread && thread.isThread()) {
              await thread.send({ content: `Enquiry ${code} was denied by ${interaction.user.tag}` }).catch(() => {});
              await thread.setArchived(true).catch(() => {});
            }
          }
        } catch (e) { console.warn('archive thread failed', e); try { notifyStaffError(e, 'deny_modal archive thread', interaction); } catch (err) {} }

        delete db.tickets[code];
        saveDB();

        try {
          await interaction.editReply({ content: `Ticket ${code} denied and transcript saved, student notified.` });
        } catch (e) {
          try { await interaction.followUp({ content: `Ticket ${code} denied and transcript saved, student notified.`, ephemeral: true }); } catch {}
        }
        return;
      }
      // If it's not a deny_modal, continue to check other modal handlers below
    }

    // MODAL SUBMITS and select menus handling etc
    if (interaction.isModalSubmit()){
      console.log(`[MODAL SUBMIT] Second block reached, customId: ${interaction.customId}, type: ${interaction.type}`);
      // Leave a review modal handler
      if (interaction.customId && interaction.customId.startsWith('review_modal|')) {
          const [, studentId, tutorId] = interaction.customId.split('|');
          
          // Verify the user is the student
          if (interaction.user.id !== studentId) {
              return interaction.reply({ content: 'Only the student can submit this review.', ephemeral: true }).catch(() => {});
          }
          
          const rating = parseInt(interaction.fields.getTextInputValue('review_rating'));
          const text = interaction.fields.getTextInputValue('review_text');
          
          // Validate rating
          if (isNaN(rating) || rating < 1 || rating > 5) {
              return interaction.reply({ content: 'Rating must be a number between 1 and 5.', ephemeral: true }).catch(() => {});
          }
          
          // Create pending review
          const review = {
              id: Date.now().toString(),
              studentId,
              tutorId,
              subject: db.studentAssignments[studentId]?.subject || 'Unknown',
              rating,
              text,
              submittedAt: Date.now(),
              approved: false
          };
          
          db.pendingReviews.push(review);
          saveDB();
          
          // Notify staff
          try {
              const staffChannel = await interaction.guild?.channels.fetch(STAFF_CHAT_ID).catch(() => null) || 
                                   await client.channels.fetch(STAFF_CHAT_ID).catch(() => null);
              if (staffChannel) {
                  const embed = new EmbedBuilder()
                      .setTitle('New Review Submitted')
                      .setDescription(`Student <@${studentId}> submitted a review for tutor <@${tutorId}>`)
                      .addFields(
                          { name: 'Rating', value: `${'⭐'.repeat(rating)} (${rating}/5)`, inline: true },
                          { name: 'Subject', value: review.subject, inline: true },
                          { name: 'Review', value: text.substring(0, 500) + (text.length > 500 ? '...' : '') }
                      )
                      .setTimestamp();
                  
                  // Add approve/deny buttons
                  // In the review_modal submit handler, update the staff notification embed:

                  // Create buttons for staff
                  const row = new ActionRowBuilder().addComponents(
                      new ButtonBuilder()
                          .setCustomId(`approve_review|${review.id}`)
                          .setLabel('Approve')
                          .setStyle(ButtonStyle.Success),
                      new ButtonBuilder()
                          .setCustomId(`deny_review|${review.id}`)
                          .setLabel('Deny')
                          .setStyle(ButtonStyle.Danger),
                      new ButtonBuilder()
                          .setCustomId(`redact_review|${review.id}`)
                          .setLabel('Redact Text')
                          .setStyle(ButtonStyle.Secondary)
                  );

                  await staffChannel.send({ embeds: [embed], components: [row] });
              }
          } catch (e) {
              console.warn('Failed to notify staff about review', e);
          }
          
          return interaction.reply({ content: 'Review submitted! It will be reviewed by staff.', ephemeral: true }).catch(() => {});
      }

            // redact review modal handler - auto-approve after redaction
              if (interaction.customId && interaction.customId.startsWith('redact_review_modal|')) {
                  const reviewId = interaction.customId.split('|')[1];
                  const reviewIndex = db.pendingReviews.findIndex(r => r.id === reviewId);
                  const review = db.pendingReviews[reviewIndex];
                  
                  if (!review) return interaction.reply({ content: 'Review not found.', ephemeral: true }).catch(() => {});
                  if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can redact reviews.', ephemeral: true }).catch(() => {});
                  
                  const redactedText = interaction.fields.getTextInputValue('redacted_text');
                  review.text = redactedText;
                  review.redacted = true;
                  
                  // Remove from pending and add to tutor's profile
                  db.pendingReviews.splice(reviewIndex, 1);
                  
                  const tutorProfile = db.tutorProfiles[review.tutorId] || { reviews: [], rating: { count: 0, avg: 0 } };
                  if (!tutorProfile.reviews) tutorProfile.reviews = [];
                  if (!tutorProfile.rating) tutorProfile.rating = { count: 0, avg: 0 };
                  
                  tutorProfile.reviews.push(review);
                  
                  // Update rating
                  const oldCount = tutorProfile.rating.count;
                  const oldAvg = tutorProfile.rating.avg;
                  const newCount = oldCount + 1;
                  const newAvg = ((oldAvg * oldCount) + review.rating) / newCount;
                  
                  tutorProfile.rating = { count: newCount, avg: newAvg };
                  db.tutorProfiles[review.tutorId] = tutorProfile;
                  saveDB();
                  
                  // Update review threads for this tutor
                  try {
                      await updateReviewThreadsForTutor(review.tutorId);
                  } catch (e) {
                      console.warn('Failed to update review threads', e);
                  }
                  
                  // Notify tutor
                  try {
                      const tutorUser = await client.users.fetch(review.tutorId).catch(() => null);
                      if (tutorUser) {
                          await tutorUser.send(`A student left you a ${'⭐'.repeat(review.rating)} star review! (Staff redacted for privacy)\n"${review.text.substring(0, 500)}"`);
                      }
                  } catch (e) { console.warn('Failed to DM tutor about redacted review', e); }
                  
                  // Update the original message
                  try {
                      await interaction.message.edit({ 
                          content: '✅ Review redacted and approved.',
                          embeds: [],
                          components: [] 
                      }).catch(() => {});
                  } catch (e) {}
                  
                  return interaction.reply({ content: 'Review text has been redacted and auto-approved.', ephemeral: true }).catch(() => {});
              }

      // sticky modal submit
      if (interaction.customId === 'sticky_modal') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can set sticky.', ephemeral: true }).catch(() => {});
        const title = interaction.fields.getTextInputValue('sticky_title') || '';
        const body = interaction.fields.getTextInputValue('sticky_body') || '';
        const color = db.defaultEmbedColor || null;

        const findChannel = await interaction.guild.channels.fetch(FIND_A_TUTOR_CHANNEL_ID).catch(() => null);
        if (!findChannel) return interaction.reply({ content: 'Find channel not found', ephemeral: true }).catch(() => {});

        // remove previous sticky if exists and post new one via helper
        db.sticky = { title, body, color, messageId: db.sticky?.messageId || null };
        saveDB();
        try {
          await repostStickyInChannel(findChannel);
        } catch (e) {
          console.warn('post sticky failed', e);
          try { notifyStaffError(e, 'sticky_modal repost', interaction); } catch (err) {}
        }
        return interaction.reply({ content: 'Sticky updated.', ephemeral: true }).catch(() => {});
      }

      // editinit modal submit
      if (interaction.customId === 'editinit_modal') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can edit init message.', ephemeral: true }).catch(() => {});
        const newInit = interaction.fields.getTextInputValue('init_message') || '';
        db.initMessage = newInit;
        saveDB();
        return interaction.reply({ content: 'Initial ticket message updated.', ephemeral: true }).catch(() => {});
      }

      // tutor_notes_modal|USERID -> staff editing notes for a tutor
      if (interaction.customId && interaction.customId.startsWith('tutor_notes_modal|')) {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can edit tutor notes.', ephemeral: true }).catch(() => {});
        const userid = interaction.customId.split('|')[1];
        const notes = interaction.fields.getTextInputValue('tutor_notes') || '';
        
        db.tutorProfiles[userid] = db.tutorProfiles[userid] || { addedAt: Date.now(), students: [], reviews: [], rating: { count: 0, avg: 0 }, notes: '' };
        db.tutorProfiles[userid].notes = notes;
        saveDB();
        
        return interaction.reply({ content: `Notes updated for tutor ${userid}.`, ephemeral: true }).catch(() => {});
      }

      // tutor_add_info_modal|USERID -> staff completing tutor add, setting optional phone/DOB
      if (interaction.customId && interaction.customId.startsWith('tutor_add_info_modal|')) {
        const userid = interaction.customId.split('|')[1];
        const phone = interaction.fields.getTextInputValue('phone') || '';
        const dob = interaction.fields.getTextInputValue('dob') || '';

        db.tutorProfiles[userid] = db.tutorProfiles[userid] || { addedAt: Date.now(), students: [], reviews: [], rating: { count: 0, avg: 0 }, notes: '' };
        if (phone) db.tutorProfiles[userid].phoneNumber = phone;
        if (dob) db.tutorProfiles[userid].dob = dob;
        saveDB();

        const infoSaved = (phone || dob) ? ` Phone/DOB saved.` : '';
        return interaction.reply({ content: `Tutor <@${userid}> added successfully.${infoSaved}` }).catch(() => {});
      }

      // tutor_edit_modal|USERID -> staff editing phone/DOB for an existing tutor
      if (interaction.customId && interaction.customId.startsWith('tutor_edit_modal|')) {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can edit tutor info.', ephemeral: true }).catch(() => {});
        const userid = interaction.customId.split('|')[1];
        const phone = interaction.fields.getTextInputValue('phone') || '';
        const dob = interaction.fields.getTextInputValue('dob') || '';

        db.tutorProfiles[userid] = db.tutorProfiles[userid] || { addedAt: Date.now(), students: [], reviews: [], rating: { count: 0, avg: 0 }, notes: '' };
        db.tutorProfiles[userid].phoneNumber = phone;
        db.tutorProfiles[userid].dob = dob;
        saveDB();

        return interaction.reply({ content: `Updated contact info for tutor <@${userid}>.`, ephemeral: true }).catch(() => {});
      }

      // close_ticket_modal|CODE -> staff provided reason, plus fields were stored temporarily on ticket._closeFlowTemp
      if (interaction.customId && interaction.customId.startsWith('close_ticket_modal|')) {
        console.log(`[CLOSE MODAL SUBMIT] Handler reached! customId: ${interaction.customId}`);
        console.log(`[CLOSE MODAL SUBMIT] Interaction type: ${interaction.type}, isModalSubmit: ${interaction.isModalSubmit()}`);
        
        // Wrap entire handler in try-catch to catch any unhandled errors
        try {
          console.log(`[CLOSE MODAL SUBMIT] Attempting to defer reply...`);
          // Defer reply immediately to acknowledge the modal (must be first!)
          await interaction.deferReply({ ephemeral: true });
          console.log(`[CLOSE MODAL SUBMIT] Successfully deferred reply`);
        } catch (deferErr) {
          console.error('Failed to defer close modal reply', deferErr);
          try { await notifyStaffError(deferErr, 'close_ticket_modal deferReply', interaction); } catch (e) {}
          // If defer fails, try to reply (but this might also fail)
          try { 
            await interaction.reply({ content: 'An error occurred. Please try again.', ephemeral: true }); 
          } catch (replyErr) {
            console.error('Failed to reply after defer failed', replyErr);
          }
          return;
        }
        
        try {
          const code = interaction.customId.split('|')[1];
          console.log(`[CLOSE MODAL SUBMIT] Extracted code: ${code}`);
          const ticket = db.tickets[code];
          if (!ticket) {
            console.log(`[CLOSE MODAL SUBMIT] Ticket ${code} not found in database`);
            try { await interaction.followUp({ content: 'Ticket not found.', ephemeral: true }); } catch (e) {
              console.error('Failed to followUp for missing ticket', e);
            }
            return;
          }
          console.log(`[CLOSE MODAL SUBMIT] Ticket ${code} found`);
          if (!isStaff(interaction.member)) {
            console.log(`[CLOSE MODAL SUBMIT] User ${interaction.user.id} is not staff`);
            try { await interaction.followUp({ content: 'Only staff can close tickets.', ephemeral: true }); } catch (e) {
              console.error('Failed to followUp for non-staff', e);
            }
            return;
          }

          let reason = '(no reason provided)';
          try {
            if (interaction.fields && typeof interaction.fields.getTextInputValue === 'function') {
              reason = interaction.fields.getTextInputValue('close_reason') || '(no reason provided)';
              console.log(`[CLOSE MODAL SUBMIT] Got reason: ${reason.substring(0, 50)}...`);
            } else {
              console.error('[CLOSE MODAL SUBMIT] interaction.fields or getTextInputValue not available');
              try { await notifyStaffError(new Error('interaction.fields not available'), 'close_ticket_modal fields check', interaction); } catch (e) {}
            }
          } catch (fieldErr) {
            console.error('[CLOSE MODAL SUBMIT] Failed to get close_reason field', fieldErr);
            try { await notifyStaffError(fieldErr, 'close_ticket_modal getTextInputValue', interaction); } catch (e) {}
          }
          
          // retrieve temp selections stored on ticket (set when staff picked selection menu)
          const temp = ticket._closeFlowTemp || {};
          console.log(`[CLOSE MODAL SUBMIT] Temp data for ticket ${code}:`, JSON.stringify(temp));
          // Capture hired flag, tutorId chosen, subjectChosen
          const hired = temp.hired === 'yes';
          const hiredTutorId = temp.hiredTutorId || null;
          let assignedSubject = temp.assignedSubject || ticket.subject || null;
          
          // Handle default subject selection
          if (assignedSubject === 'ticket_subject') {
            assignedSubject = ticket.subject;
          }

          // Proceed to close similar to old /close but include assignment if hired
          try {
          if (!interaction.guild) {
            try { await interaction.followUp({ content: 'Error: This command must be used in a server.', ephemeral: true }); } catch (e) {}
            return;
          }
          
          // Send success message immediately (before heavy work)
          let successSent = false;
          try {
            await interaction.followUp({ content: `Ticket ${code} closed.`, ephemeral: true });
            successSent = true;
          } catch (followErr) {
            console.error('Failed to send success message', followErr);
            // Continue with closing even if message fails
          }
          
          // archive tutors thread
          try {
            if (ticket.tutorThreadId) {
              const thread = await interaction.guild.channels.fetch(ticket.tutorThreadId).catch(() => null);
              if (thread && thread.isThread()) {
                await thread.send({ content: `Enquiry ${code} was closed by ${interaction.user.tag}` }).catch(() => {});
                await thread.setArchived(true).catch(() => {});
              }
            }
          } catch (e) { console.warn('archive thread failed', e); try { notifyStaffError(e, 'close archive', interaction); } catch (err) {} }

          // transcript
          const lines = [];
          lines.push(`Transcript for ticket ${code}`);
          lines.push(`Subject: ${ticket.subject}`);
          lines.push(`Student ID: ${ticket.studentId}`);
          lines.push(`Closed by: ${interaction.user.tag}`);
          lines.push(`Reason: ${reason}`);
          if (hired && hiredTutorId) {
            let tutorName = hiredTutorId;
            try {
              const member = await interaction.guild.members.fetch(hiredTutorId).catch(() => null);
              if (member) tutorName = member.user.tag;
            } catch (e) {}
            lines.push(`Assigned tutor: ${tutorName}, subject: ${assignedSubject}`);
          }
          lines.push('----------------------------------');
          for (const m of ticket.messages || []) {
            const when = `<t:${Math.floor(m.at / 1000)}:f>`;
            let row = `[${when}] ${m.who}: ${m.text || ''}`;
            if (m.attachments && m.attachments.length) row += `\nAttachments: ${m.attachments.join(' ')}`;
            lines.push(row);
          }
          lines.push('----------------------------------\nEnd of transcript');

          try {
            const transcriptsChannel = await interaction.guild.channels.fetch(TRANSCRIPTS_CHANNEL_ID).catch(() => null);
            if (transcriptsChannel) {
              const fullTranscript = lines.join('\n');
              const chunks = splitMessage(fullTranscript, 2000);
              
              // Send transcript in chunks
              for (let i = 0; i < chunks.length; i++) {
                await transcriptsChannel.send(chunks[i]).catch((err) => {
                  console.warn('Failed to send transcript chunk', err);
                });
                // Small delay between chunks to avoid rate limiting (only if not last chunk)
                if (i < chunks.length - 1) {
                  await new Promise(resolve => setTimeout(resolve, 100));
                }
              }
              
              // Send attachments separately
              for (const m of ticket.messages || []) {
                if (m.attachments && m.attachments.length) {
                  for (const url of m.attachments) {
                    try { await transcriptsChannel.send({ content: url }).catch(() => {}); } catch (e) {}
                  }
                }
              }
            }
          } catch (e) { console.warn('send transcript failed', e); try { notifyStaffError(e, 'close send transcript', interaction); } catch (err) {} }

          // DM student notification
          try {
            const studentUser = await client.users.fetch(ticket.studentId).catch(() => null);
            if (studentUser) {
              let dmText = `Your enquiry (${code}) about ${ticket.subject} was closed by staff.\nReason: ${reason}`;
              if (hired && hiredTutorId) {
                let tutorName = hiredTutorId;
                try {
                  const member = await interaction.guild.members.fetch(hiredTutorId).catch(() => null);
                  if (member) tutorName = member.user.tag;
                } catch (e) {}
                dmText += `\nYou were assigned to tutor ${tutorName} for ${assignedSubject}.`;
              }
              dmText += `\nTranscript saved.`;
              await studentUser.send(dmText).catch(() => { console.warn('could not DM student'); });
            }
          } catch (e) { console.warn('DM failed', e); try { notifyStaffError(e, 'close DM student', interaction); } catch (err) {} }

          // channel deletion or hide
          try {
            const ticketChannel = await interaction.guild.channels.fetch(ticket.ticketChannelId).catch(() => null);
            if (ticketChannel) {
              await ticketChannel.send('Ticket closed by staff, deleting channel now.').catch(() => {});
              await ticketChannel.delete('Ticket closed by staff').catch(async (err) => {
                console.warn('delete failed, try hide', err);
                try { await ticketChannel.permissionOverwrites.edit(ticket.studentId, { ViewChannel: false, SendMessages: false }).catch(() => {}); } catch (e) { console.warn('hide failed', e); }
              });
            }
          } catch (e) { console.warn('channel finalize failed', e); try { notifyStaffError(e, 'close finalize channel', interaction); } catch (err) {} }

          // assign student to tutor if hired
          if (hired && hiredTutorId) {
            try {
              // store assignment
              const now = Date.now();
              db.studentAssignments[ticket.studentId] = { tutorId: hiredTutorId, subject: assignedSubject, assignedAt: now, reviewScheduledAt: now + (db.reviewConfig.delaySeconds || 1296000) * 1000 };
              db.tutorProfiles[hiredTutorId] = db.tutorProfiles[hiredTutorId] || { addedAt: Date.now(), students: [], reviews: [], rating: { count: 0, avg: 0 }, notes: '' };
              if (!db.tutorProfiles[hiredTutorId].students) db.tutorProfiles[hiredTutorId].students = [];
              if (!db.tutorProfiles[hiredTutorId].students.includes(ticket.studentId)) db.tutorProfiles[hiredTutorId].students.push(ticket.studentId);
              saveDB();
            } catch (e) {
              console.warn('failed to assign student to tutor', e);
              try { notifyStaffError(e, 'close assign student', interaction); } catch (err) {}
            }
          }

          // cleanup - clean up temp data before deleting ticket
          if (ticket._closeFlowTemp) {
            delete ticket._closeFlowTemp;
          }
          delete db.tickets[code];
          saveDB();
          
          // Success message was already sent at the beginning, no need to send again
        } catch (e) {
          console.error('close flow failed', e);
          try { 
            await notifyStaffError(e, 'close flow modal', interaction); 
          } catch (err) {
            console.error('Failed to notify staff about close error', err);
          }
          try { 
            await interaction.followUp({ content: 'Failed to close ticket, staff notified.', ephemeral: true }); 
          } catch (followErr) {
            console.error('Failed to followUp error message', followErr);
          }
        }
        } catch (outerErr) {
          // Catch any errors that occur outside the inner try-catch
          console.error('Outer error in close_ticket_modal handler', outerErr);
          try { 
            await notifyStaffError(outerErr, 'close_ticket_modal outer catch', interaction); 
          } catch (err) {
            console.error('Failed to notify staff about outer error', err);
          }
          try { 
            await interaction.followUp({ content: 'An unexpected error occurred. Staff have been notified.', ephemeral: true }); 
          } catch (followErr) {
            console.error('Failed to followUp in outer catch', followErr);
          }
        }
        return;
      }
    }

    // Select menus and other interaction types
    if (interaction.isStringSelectMenu()) {
      // Tutor select handler for username-based flows (info / notes / remove)
      if (interaction.customId && interaction.customId.startsWith('tutor_select|')) {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can do this.', ephemeral: true }).catch(() => {});
        const { baseCustomId, page } = parsePagedCustomId(interaction.customId);
        const parts = baseCustomId.split('|');
        // customId formats:
        // tutor_select|info
        // tutor_select|notes
        // tutor_select|remove|<subject>
        const subAction = parts[1];
        const selected = interaction.values && interaction.values[0];
        if (!selected) return interaction.reply({ content: 'No tutor selected.', ephemeral: true }).catch(() => {});

        if (isPagedNavigationValue(selected)) {
          const targetPage = getPagedNavigationTarget(page, selected);
          if (subAction === 'info') {
            const options = await buildTutorSelectOptions(interaction.guild, getAllTutorIds());
            const select = buildPaginatedSelectMenu({ baseCustomId, placeholder: 'Select a tutor to view info', options, page: targetPage });
            return interaction.update({ content: 'Select a tutor to view info:', components: [new ActionRowBuilder().addComponents(select)] }).catch(() => {});
          }
          if (subAction === 'notes') {
            const options = await buildTutorSelectOptions(interaction.guild, getAllTutorIds());
            const select = buildPaginatedSelectMenu({ baseCustomId, placeholder: 'Select a tutor to edit notes', options, page: targetPage });
            return interaction.update({ content: 'Select a tutor to edit notes:', components: [new ActionRowBuilder().addComponents(select)] }).catch(() => {});
          }
          if (subAction === 'edit') {
            const options = await buildTutorSelectOptions(interaction.guild, getAllTutorIds());
            const select = buildPaginatedSelectMenu({ baseCustomId, placeholder: 'Select a tutor to edit contact info', options, page: targetPage });
            return interaction.update({ content: 'Select a tutor to edit their phone number and date of birth:', components: [new ActionRowBuilder().addComponents(select)] }).catch(() => {});
          }
          if (subAction === 'remove') {
            const subj = parts[2];
            const options = await buildTutorSelectOptions(interaction.guild, (db.subjectTutors[subj] || []).map(id => String(id)));
            const select = buildPaginatedSelectMenu({ baseCustomId, placeholder: 'Select tutor to remove from subject', options, page: targetPage });
            return interaction.update({ content: `Select a tutor to remove from ${subj}:`, components: [new ActionRowBuilder().addComponents(select)] }).catch(() => {});
          }
        }

        if (subAction === 'info') {
          const userid = String(selected);
          const subjects = [];
          for (const s of db.subjects) {
            const arr = db.subjectTutors[s] || [];
            if (arr.includes(userid)) subjects.push(s);
          }
          const profile = db.tutorProfiles[userid] || { addedAt: null, students: [], reviews: [], rating: { count: 0, avg: 0 } };
          const addedAt = profile && profile.addedAt ? `<t:${Math.floor(profile.addedAt/1000)}:f>` : '(unknown)';
          let userTag = '(not in guild)';
          let joined = '(unknown)';
          try {
            const member = await interaction.guild.members.fetch(userid).catch(() => null);
            if (member) {
              userTag = member.user.tag;
              joined = member.joinedAt ? `<t:${Math.floor(member.joinedAt.getTime()/1000)}:f>` : '(unknown)';
            } else {
              const user = await client.users.fetch(userid).catch(() => null);
              if (user) userTag = user.tag;
            }
          } catch (e) {}

          const rating = profile.rating && profile.rating.count ? `${(Number(profile.rating.avg) || 0).toFixed(2)} ⭐️ (${profile.rating.count})` : '(no ratings)';
          const studentList = (profile.students && profile.students.length)
            ? (await Promise.all(profile.students.map(studentId => formatUserLabel(interaction.guild, studentId)))).join(', ')
            : '(none)';
          const notes = profile.notes || '(no notes)';
          const phone = profile.phoneNumber || '(not set)';
          const dob = profile.dob || '(not set)';
          const lines = [
            `Tutor info for: ${userTag} (${userid})`,
            `Guild joined: ${joined}`,
            `Tutor added at: ${addedAt}`,
            `Subjects: ${subjects.length ? subjects.join(', ') : '(none)'}`,
            `Assigned students: ${studentList}`,
            `Rating: ${rating}`,
            `Phone: ${phone}`,
            `DOB: ${dob}`,
            `Notes: ${notes}`
          ];
          try {
            await interaction.update({ content: lines.join('\n'), components: [] });
          } catch (e) {
            try { await interaction.reply({ content: lines.join('\n'), ephemeral: true }); } catch (err) { console.warn('tutor_select info reply failed', err); }
          }
          return;
        }

        if (subAction === 'notes') {
          const userid = String(selected);
          db.tutorProfiles[userid] = db.tutorProfiles[userid] || { addedAt: Date.now(), students: [], reviews: [], rating: { count: 0, avg: 0 }, notes: '' };
          const currentNotes = db.tutorProfiles[userid].notes || '';
          const modal = new ModalBuilder()
            .setCustomId(`tutor_notes_modal|${userid}`)
            .setTitle(`Tutor Notes`);
          const notesInput = new TextInputBuilder()
            .setCustomId('tutor_notes')
            .setLabel('Notes for this tutor')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setValue(currentNotes.substring(0, 4000))
            .setPlaceholder('Enter notes about this tutor...')
            .setMaxLength(4000);
          modal.addComponents(new ActionRowBuilder().addComponents(notesInput));
          try { await interaction.showModal(modal); } catch (err) { try { notifyStaffError(err, 'tutor_select showModal notes', interaction); } catch (e) {} return interaction.reply({ content: 'Could not open notes modal, try again.', ephemeral: true }); }
          return;
        }

        if (subAction === 'edit') {
          const userid = String(selected);
          db.tutorProfiles[userid] = db.tutorProfiles[userid] || { addedAt: Date.now(), students: [], reviews: [], rating: { count: 0, avg: 0 }, notes: '' };
          const profile = db.tutorProfiles[userid];
          const modal = new ModalBuilder()
            .setCustomId(`tutor_edit_modal|${userid}`)
            .setTitle('Edit Tutor Contact Info');
          const phoneInput = new TextInputBuilder()
            .setCustomId('phone')
            .setLabel('Phone Number')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setValue((profile.phoneNumber || '').substring(0, 100))
            .setPlaceholder('e.g. +1 234 567 890');
          const dobInput = new TextInputBuilder()
            .setCustomId('dob')
            .setLabel('Date of Birth')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setValue((profile.dob || '').substring(0, 100))
            .setPlaceholder('e.g. YYYY-MM-DD');
          modal.addComponents(
            new ActionRowBuilder().addComponents(phoneInput),
            new ActionRowBuilder().addComponents(dobInput)
          );
          try { await interaction.showModal(modal); } catch (err) { try { notifyStaffError(err, 'tutor_select showModal edit', interaction); } catch (e) {} return interaction.reply({ content: 'Could not open edit modal, try again.', ephemeral: true }).catch(() => {}); }
          return;
        }

        if (subAction === 'remove') {
          const subj = parts[2];
          if (!subj) return interaction.reply({ content: 'Subject not specified for removal.', ephemeral: true }).catch(() => {});
          const userid = String(selected);
          db.subjectTutors[subj] = (db.subjectTutors[subj] || []).filter(id => id !== userid);
          saveDB();
          try { await revokeTutorAccess(userid); } catch (e) { console.warn('revokeTutorAccess failed', e); try { notifyStaffError(e, 'tutor_select revokeTutorAccess', interaction); } catch (err) {} }
          const tutorUser = await client.users.fetch(userid).catch(() => null);
          const tutorDisplay = tutorUser ? `${tutorUser.username} (${userid})` : userid;
          try {
            await interaction.update({ content: `Removed tutor ${tutorDisplay} from ${subj}, access revoked.`, components: [] });
          } catch (e) {
            try { await interaction.reply({ content: `Removed tutor ${tutorDisplay} from ${subj}, access revoked.`, ephemeral: true }); } catch (err) { console.warn('tutor_select remove reply failed', err); }
          }
          return;
        }
      }

      // Handler for /tutor add select flow: subject and tutor selection
      if (interaction.customId && interaction.customId.startsWith('tutor_add_select|')) {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can do this.', ephemeral: true }).catch(() => {});
        const { baseCustomId, page } = parsePagedCustomId(interaction.customId);
        const parts = baseCustomId.split('|');
        const which = parts[1];
        db._tempTutorAdd = db._tempTutorAdd || {};
        const key = interaction.user.id;
        db._tempTutorAdd[key] = db._tempTutorAdd[key] || { subject: null, userid: null };

        if (which === 'subject') {
          const selected = interaction.values && interaction.values[0];
          if (!selected) return interaction.reply({ content: 'No subject selected.', ephemeral: true }).catch(() => {});
          if (isPagedNavigationValue(selected)) {
            const targetPage = getPagedNavigationTarget(page, selected);
            const levelKey = db._tempTutorAdd[key]?.level || null;
            const levelLabel = SUBJECT_LEVEL_LABELS[levelKey] || levelKey || 'Selected';
            const subjectOptions = buildSubjectSelectOptions(getSubjectsForLevel(levelKey));
            const subjectSelect = buildPaginatedSelectMenu({
              baseCustomId,
              placeholder: `Select subject (${levelLabel})`,
              options: subjectOptions,
              page: targetPage
            });
            const storedUserId = db._tempTutorAdd[key].userid;
            const tutorPart = storedUserId ? ` for <@${storedUserId}>` : '';
            return interaction.update({
              content: `Level **${levelLabel}** selected${tutorPart}. **Step 2:** Select the subject:`,
              components: [new ActionRowBuilder().addComponents(subjectSelect)]
            }).catch(() => {});
          }
          db._tempTutorAdd[key].subject = selected;
          saveDB();
          // If userid already chosen, finalize
          if (db._tempTutorAdd[key].userid) {
            const userid = db._tempTutorAdd[key].userid;
            const subj = db._tempTutorAdd[key].subject;
            db.subjectTutors[subj] = db.subjectTutors[subj] || [];
            if (!db.subjectTutors[subj].includes(userid)) db.subjectTutors[subj].push(userid);
            db.tutorProfiles[userid] = db.tutorProfiles[userid] || { addedAt: Date.now(), students: [], reviews: [], rating: { count:0, avg:0 }, notes: '' };
            delete db._tempTutorAdd[key];
            saveDB();
            // Start grantTutorAccess in background before showing modal
            (async () => { try { await grantTutorAccess(userid); } catch (e) { try { notifyStaffError(e, 'tutor_add_select grantTutorAccess', interaction); } catch (err) {} } })();
            // Show phone/DOB modal as the response
            const profile = db.tutorProfiles[userid];
            const modal = new ModalBuilder()
              .setCustomId(`tutor_add_info_modal|${userid}`)
              .setTitle('New Tutor — Contact Info (Optional)');
            const phoneInput = new TextInputBuilder()
              .setCustomId('phone').setLabel('Phone Number').setStyle(TextInputStyle.Short)
              .setRequired(false).setValue((profile.phoneNumber || '').substring(0, 100)).setPlaceholder('e.g. +1 234 567 890');
            const dobInput = new TextInputBuilder()
              .setCustomId('dob').setLabel('Date of Birth').setStyle(TextInputStyle.Short)
              .setRequired(false).setValue((profile.dob || '').substring(0, 100)).setPlaceholder('e.g. YYYY-MM-DD');
            modal.addComponents(new ActionRowBuilder().addComponents(phoneInput), new ActionRowBuilder().addComponents(dobInput));
            try {
              await interaction.showModal(modal);
            } catch (err) {
              try { await interaction.update({ content: `Added tutor <@${userid}> to **${subj}**, access grant started.`, components: [] }); } catch (e) { try { await interaction.reply({ content: `Added tutor <@${userid}> to **${subj}**, access grant started.`, ephemeral: true }); } catch (err2) { console.warn('tutor_add_select subject reply failed', err2); } }
            }
            return;
          }
          try {
            await interaction.update({ content: `Session expired — no tutor was recorded for subject **${selected}**. Please run \`/tutor add user:@mention\` again to restart the flow.`, components: [] });
          } catch (e) {
            try { await interaction.reply({ content: `Session expired — no tutor was recorded for subject **${selected}**. Please run \`/tutor add user:@mention\` again to restart the flow.`, ephemeral: true }); } catch (err) { console.warn('tutor_add_select subject reply failed', err); }
          }
          return;
        }

        if (which === 'tutor') {
          const selected = interaction.values && interaction.values[0];
          if (!selected) return interaction.reply({ content: 'No tutor selected.', ephemeral: true }).catch(() => {});
          db._tempTutorAdd[key].userid = String(selected);
          saveDB();
          if (db._tempTutorAdd[key].subject) {
            const userid = db._tempTutorAdd[key].userid;
            const subj = db._tempTutorAdd[key].subject;
            db.subjectTutors[subj] = db.subjectTutors[subj] || [];
            if (!db.subjectTutors[subj].includes(userid)) db.subjectTutors[subj].push(userid);
            db.tutorProfiles[userid] = db.tutorProfiles[userid] || { addedAt: Date.now(), students: [], reviews: [], rating: { count:0, avg:0 }, notes: '' };
            delete db._tempTutorAdd[key];
            saveDB();
            // Start grantTutorAccess in background before showing modal
            (async () => { try { await grantTutorAccess(userid); } catch (e) { try { notifyStaffError(e, 'tutor_add_select grantTutorAccess', interaction); } catch (err) {} } })();
            // Show phone/DOB modal as the response
            const profile = db.tutorProfiles[userid];
            const modal = new ModalBuilder()
              .setCustomId(`tutor_add_info_modal|${userid}`)
              .setTitle('New Tutor — Contact Info (Optional)');
            const phoneInput = new TextInputBuilder()
              .setCustomId('phone').setLabel('Phone Number').setStyle(TextInputStyle.Short)
              .setRequired(false).setValue((profile.phoneNumber || '').substring(0, 100)).setPlaceholder('e.g. +1 234 567 890');
            const dobInput = new TextInputBuilder()
              .setCustomId('dob').setLabel('Date of Birth').setStyle(TextInputStyle.Short)
              .setRequired(false).setValue((profile.dob || '').substring(0, 100)).setPlaceholder('e.g. YYYY-MM-DD');
            modal.addComponents(new ActionRowBuilder().addComponents(phoneInput), new ActionRowBuilder().addComponents(dobInput));
            try {
              await interaction.showModal(modal);
            } catch (err) {
              try { await interaction.update({ content: `Added tutor <@${userid}> to **${subj}**, access grant started.`, components: [] }); } catch (e) { try { await interaction.reply({ content: `Added tutor <@${userid}> to **${subj}**, access grant started.`, ephemeral: true }); } catch (err2) { console.warn('tutor_add_select tutor reply failed', err2); } }
            }
            return;
          }
          try {
            await interaction.update({ content: `Tutor <@${selected}> selected. Now choose a subject to add them to.`, components: interaction.message.components });
          } catch (e) {
            try { await interaction.reply({ content: `Tutor <@${selected}> selected. Now choose a subject to add them to.`, ephemeral: true }); } catch (err) { console.warn('tutor_add_select tutor reply failed', err); }
          }
          return;
        }
      }
      // Handler for tutor_add_level: staff selected a level category, now show filtered subjects only
      if (interaction.customId && interaction.customId.startsWith('tutor_add_level|')) {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can do this.', ephemeral: true }).catch(() => {});
        const chosenRaw = interaction.values && interaction.values[0];
        const levelKey = normalizeSubjectLevelKey(chosenRaw);
        if (!levelKey) return interaction.reply({ content: 'Invalid level selected.', ephemeral: true }).catch(() => {});
        const levelLabel = SUBJECT_LEVEL_LABELS[levelKey] || levelKey;
        const key = interaction.user.id;
        db._tempTutorAdd = db._tempTutorAdd || {};
        db._tempTutorAdd[key] = db._tempTutorAdd[key] || { subject: null, userid: null };
        db._tempTutorAdd[key].level = levelKey;
        saveDB();

        const rows = [];
        const subjOptions = buildSubjectSelectOptions(getSubjectsForLevel(levelKey));
        if (!subjOptions.length) {
          try { await interaction.update({ content: `No subjects found for **${levelLabel}**. Add subjects first with \`/subject add\`.`, components: [] }); } catch (e) { try { await interaction.reply({ content: `No subjects found for **${levelLabel}**.`, ephemeral: true }); } catch (err) {} }
          return;
        }
        rows.push(new ActionRowBuilder().addComponents(
          buildPaginatedSelectMenu({ baseCustomId: 'tutor_add_select|subject', placeholder: `Select subject (${levelLabel})`, options: subjOptions })
        ));

        // Build tutor display for the message from temp storage
        const storedUserId = db._tempTutorAdd[key].userid;
        const tutorPart = storedUserId ? ` for <@${storedUserId}>` : '';
        try {
          await interaction.update({ content: `Level **${levelLabel}** selected${tutorPart}. **Step 2:** Select the subject:`, components: rows });
        } catch (e) {
          try { await interaction.reply({ content: `Level **${levelLabel}** selected${tutorPart}. **Step 2:** Select the subject:`, components: rows }); } catch (err) { console.warn('tutor_add_level reply failed', err); }
        }
        return;
      }
      // Handler for /tutor remove select flow: subject and tutor selection
      if (interaction.customId && interaction.customId.startsWith('tutor_remove_select|')) {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can do this.', ephemeral: true }).catch(() => {});
        const { baseCustomId, page } = parsePagedCustomId(interaction.customId);
        const parts = baseCustomId.split('|');
        const which = parts[1];
        db._tempTutorRemove = db._tempTutorRemove || {};
        const key = interaction.user.id;
        db._tempTutorRemove[key] = db._tempTutorRemove[key] || { subject: null, userid: null };

        if (which === 'subject') {
          const selected = interaction.values && interaction.values[0];
          if (!selected) return interaction.reply({ content: 'No subject selected.', ephemeral: true }).catch(() => {});
          if (isPagedNavigationValue(selected)) {
            const targetPage = getPagedNavigationTarget(page, selected);
            const storedTutorId = db._tempTutorRemove[key].userid;
            const subjectOptions = storedTutorId
              ? buildSubjectSelectOptions(
                  Object.entries(db.subjectTutors || {})
                    .filter(([, ids]) => ids.includes(storedTutorId))
                    .map(([subject]) => subject)
                )
              : buildSubjectSelectOptions(db.subjects || []);
            const subjectSelect = buildPaginatedSelectMenu({
              baseCustomId,
              placeholder: 'Select subject to remove tutor from',
              options: subjectOptions,
              page: targetPage
            });
            if (storedTutorId) {
              return interaction.update({
                content: `Select the subject to remove <@${storedTutorId}> from:`,
                components: [new ActionRowBuilder().addComponents(subjectSelect)]
              }).catch(() => {});
            }
            const tutorSelect = buildPaginatedSelectMenu({
              baseCustomId: 'tutor_remove_select|tutor',
              placeholder: 'Select tutor to remove',
              options: await buildTutorSelectOptions(interaction.guild, getAllTutorIds()),
              page: 0
            });
            return interaction.update({
              content: 'Select subject and tutor to remove:',
              components: [
                new ActionRowBuilder().addComponents(subjectSelect),
                new ActionRowBuilder().addComponents(tutorSelect)
              ]
            }).catch(() => {});
          }
          db._tempTutorRemove[key].subject = selected;
          saveDB();
          if (db._tempTutorRemove[key].userid) {
            const userid = db._tempTutorRemove[key].userid;
            const subj = db._tempTutorRemove[key].subject;
            db.subjectTutors[subj] = (db.subjectTutors[subj] || []).filter(id => id !== userid);
            saveDB();
            try { await revokeTutorAccess(userid); } catch (e) { console.warn('revokeTutorAccess failed', e); try { notifyStaffError(e, 'tutor_remove_select revokeTutorAccess', interaction); } catch (err) {} }
            delete db._tempTutorRemove[key];
            const tutorUser = await client.users.fetch(userid).catch(() => null);
            const tutorDisplay = tutorUser ? `${tutorUser.username} (${userid})` : userid;
            try { await interaction.update({ content: `Removed tutor ${tutorDisplay} from ${subj}, access revoked.`, components: [] }); } catch (e) { try { await interaction.reply({ content: `Removed tutor ${tutorDisplay} from ${subj}, access revoked.`, ephemeral: true }); } catch (err) { console.warn('tutor_remove_select subject reply failed', err); } }
            return;
          }
          try { await interaction.update({ content: `Subject ${selected} selected. Now choose a tutor to remove.`, components: interaction.message.components }); } catch (e) { try { await interaction.reply({ content: `Subject ${selected} selected. Now choose a tutor to remove.`, ephemeral: true }); } catch (err) { console.warn('tutor_remove_select subject reply failed', err); } }
          return;
        }

        if (which === 'tutor') {
          const selected = interaction.values && interaction.values[0];
          if (!selected) return interaction.reply({ content: 'No tutor selected.', ephemeral: true }).catch(() => {});
          if (isPagedNavigationValue(selected)) {
            const targetPage = getPagedNavigationTarget(page, selected);
            const subjectForTutor = parts[2];
            if (subjectForTutor) {
              const options = await buildTutorSelectOptions(interaction.guild, (db.subjectTutors[subjectForTutor] || []).map(id => String(id)));
              const select = buildPaginatedSelectMenu({
                baseCustomId,
                placeholder: 'Select tutor to remove from subject',
                options,
                page: targetPage
              });
              return interaction.update({
                content: `Select a tutor to remove from ${subjectForTutor}:`,
                components: [new ActionRowBuilder().addComponents(select)]
              }).catch(() => {});
            }
            const subjectSelect = buildPaginatedSelectMenu({
              baseCustomId: 'tutor_remove_select|subject',
              placeholder: 'Select subject to remove tutor from',
              options: buildSubjectSelectOptions(db.subjects || []),
              page: 0
            });
            const tutorSelect = buildPaginatedSelectMenu({
              baseCustomId,
              placeholder: 'Select tutor to remove',
              options: await buildTutorSelectOptions(interaction.guild, getAllTutorIds()),
              page: targetPage
            });
            return interaction.update({
              content: 'Select subject and tutor to remove:',
              components: [
                new ActionRowBuilder().addComponents(subjectSelect),
                new ActionRowBuilder().addComponents(tutorSelect)
              ]
            }).catch(() => {});
          }
          db._tempTutorRemove[key].userid = String(selected);
          saveDB();
          if (db._tempTutorRemove[key].subject) {
            const userid = db._tempTutorRemove[key].userid;
            const subj = db._tempTutorRemove[key].subject;
            db.subjectTutors[subj] = (db.subjectTutors[subj] || []).filter(id => id !== userid);
            saveDB();
            try { await revokeTutorAccess(userid); } catch (e) { console.warn('revokeTutorAccess failed', e); try { notifyStaffError(e, 'tutor_remove_select revokeTutorAccess', interaction); } catch (err) {} }
            delete db._tempTutorRemove[key];
            const tutorUser = await client.users.fetch(userid).catch(() => null);
            const tutorDisplay = tutorUser ? `${tutorUser.username} (${userid})` : userid;
            try { await interaction.update({ content: `Removed tutor ${tutorDisplay} from ${subj}, access revoked.`, components: [] }); } catch (e) { try { await interaction.reply({ content: `Removed tutor ${tutorDisplay} from ${subj}, access revoked.`, ephemeral: true }); } catch (err) { console.warn('tutor_remove_select tutor reply failed', err); } }
            return;
          }
          try { await interaction.update({ content: `Tutor ${selected} selected. Now choose a subject to remove them from.`, components: interaction.message.components }); } catch (e) { try { await interaction.reply({ content: `Tutor ${selected} selected. Now choose a subject to remove them from.`, ephemeral: true }); } catch (err) { console.warn('tutor_remove_select tutor reply failed', err); } }
          return;
        }
      }
      // Close-ticket select flow:
      // We show an ephemeral message with two selects and a button to open a modal for reason.
      // The staff will choose whether hired, optionally choose tutor, choose subject.
      // The selections are saved temporarily on the ticket object at ticket._closeFlowTemp

      // In the select menu section (around line 570-600), update the review_sort handler:
      if (interaction.customId && interaction.customId.startsWith('review_sort|')) {
        const [, tutorId, currentPage] = interaction.customId.split('|');
        const page = parseInt(currentPage) || 0;
        const sortMethod = interaction.values[0];

        try {
          const messageData = await sendReviewPage(tutorId, page, sortMethod);
          if (messageData) {
            await interaction.update(messageData);
          } else {
            await interaction.reply({ content: 'Failed to load reviews.', ephemeral: true });
          }
        } catch (error) {
          console.error('Failed to update review sort:', error);
          try { await notifyStaffError(error, 'review_sort handler', interaction); } catch (e) {}
          try {
            if (!interaction.replied && !interaction.deferred) {
              await interaction.reply({ content: 'Failed to update review list.', ephemeral: true });
            } else {
              await interaction.followUp({ content: 'Failed to update review list.', ephemeral: true });
            }
          } catch (e) {}
        }
        return;
      }

      if (interaction.customId && interaction.customId.startsWith('close_ticket_select|')) {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can do this.', ephemeral: true }).catch(() => {});

        const { baseCustomId, page } = parsePagedCustomId(interaction.customId);
        const cmdParts = baseCustomId.split('|');
        const code = cmdParts[1];
        const which = cmdParts[2];
        const ticket = db.tickets[code];
        if (!ticket) return interaction.reply({ content: 'Ticket not found.', ephemeral: true }).catch(() => {});

        ticket._closeFlowTemp = ticket._closeFlowTemp || {};
        if (!interaction.values || interaction.values.length === 0) {
          return interaction.reply({ content: 'No option was selected.', ephemeral: true }).catch(() => {});
        }
        const selectedValue = interaction.values[0];
        console.log(`[CLOSE SELECT] Ticket ${code}, which: ${which}, value: ${selectedValue}`);
  
        if (which === 'hired') {
          ticket._closeFlowTemp.hired = selectedValue || 'no';
          console.log(`[CLOSE SELECT] Saved hired selection: ${ticket._closeFlowTemp.hired} for ticket ${code}`);
          saveDB();
          console.log(`[CLOSE SELECT] Database saved after hired selection`);
          return interaction.update({ content: 'Selection saved. Now choose tutor and subject, then click "Provide reason and close".', components: interaction.message.components }).catch(() => {});
        } else if (which === 'tutor') {
        if (isPagedNavigationValue(selectedValue)) {
          const components = await buildCloseFlowComponents(interaction.guild, code, ticket, { tutorPage: getPagedNavigationTarget(page, selectedValue), subjectPage: 0 });
          return interaction.update({ content: 'Please pick whether the student was hired, the tutor if yes, and the subject. Then click Provide reason and close.', components }).catch(() => {});
        }
        const selectedTutorId = selectedValue || null;
        ticket._closeFlowTemp.hiredTutorId = selectedTutorId;
        console.log(`[CLOSE SELECT] Saved tutor selection: ${selectedTutorId} for ticket ${code}`);
  
        // Update subject dropdown to only show subjects this tutor teaches
        if (selectedTutorId && selectedTutorId !== 'none') {
          const tutorSubjects = Object.entries(db.subjectTutors || {})
            .filter(([, tutors]) => tutors.includes(selectedTutorId))
            .map(([subj]) => subj);
          if (tutorSubjects.length > 0) {
            const components = await buildCloseFlowComponents(interaction.guild, code, ticket, { tutorPage: 0, subjectPage: 0 });
            saveDB();
            return interaction.update({ content: `Tutor selected. Now choose a subject this tutor teaches.`, components }).catch(() => {});
          }
        }
          saveDB();
          return interaction.update({ content: 'Selection saved. Now choose subject, then click "Provide reason and close".', components: interaction.message.components }).catch(() => {});
        } else if (which === 'subject') {
          if (isPagedNavigationValue(selectedValue)) {
            const components = await buildCloseFlowComponents(interaction.guild, code, ticket, { tutorPage: 0, subjectPage: getPagedNavigationTarget(page, selectedValue) });
            return interaction.update({ content: 'Please pick whether the student was hired, the tutor if yes, and the subject. Then click Provide reason and close.', components }).catch(() => {});
          }
          const selected = selectedValue;
          ticket._closeFlowTemp.assignedSubject = selected === 'ticket_subject' ? ticket.subject : selected;
          console.log(`[CLOSE SELECT] Saved subject selection: ${ticket._closeFlowTemp.assignedSubject} for ticket ${code}`);
          console.log(`[CLOSE SELECT] Full temp data for ticket ${code}:`, JSON.stringify(ticket._closeFlowTemp));
    saveDB();
    console.log(`[CLOSE SELECT] Database saved after subject selection`);
    return interaction.update({ content: 'Selection saved, click "Provide reason and close" when ready.', components: interaction.message.components, ephemeral: true }).catch(() => {});
  }
      }


    }

    // CHAT INPUT COMMANDS
    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;

      // ENQUIRE (unchanged)
      if (cmd === 'enquire') {
        const enquirySubject = interaction.options.getString('subject', true);
        await createEnquiryTicketFromInteraction(interaction, {
          subject: enquirySubject,
          source: 'enquire',
          creatingMessage: 'Creating your ticket...',
          successVerb: 'Continue in'
        });
        return;

        const overwrites = [
          { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          ...getStaffRoleIds().map(rid => ({ id: rid, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles] })),
          { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
          { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageMessages, PermissionsBitField.Flags.EmbedLinks] }
        ];
        const channelData = { name: buildTicketChannelName(interaction.user, subject), type: 0, permissionOverwrites: overwrites };
        if (TICKET_CATEGORY_ID) channelData.parent = TICKET_CATEGORY_ID;
        const ticketChannel = await guild.channels.create(channelData).catch(err => { console.error('create channel failed', err); try { notifyStaffError(err, 'enquire create channel', interaction); } catch (e) {} return null; });
        if (!ticketChannel) return interaction.editReply({ content: `Failed to create ticket channel.`, ephemeral: true }).catch(() => {});

        const initMsg = db.initMessage.replace('{subject}', subject);
        await ticketChannel.send({ content: `<@${interaction.user.id}>\n${initMsg}` }).catch(() => {});

        db.tickets[code] = {
          ticketChannelId: ticketChannel.id,
          studentId: interaction.user.id,
          studentName: interaction.user.username,
          studentTag: interaction.user.tag,
          tutorMessageId: null,
          tutorThreadId: null,
          subject,
          approved: false,
          awaitingApproval: false,
          tutorCount: 0,
          tutorMap: {},
          messages: [],
          createdAt: Date.now()
        };
        db.cooldowns[interaction.user.id] = Date.now();
        saveDB();

        await interaction.editReply({ content: `Ticket created for <@${interaction.user.id}> (code **${code}**). Continue in <#${ticketChannel.id}>.` }).catch(() => {});
        await ticketChannel.send(`Ticket created for <@${interaction.user.id}> (code **${code}**), subject: ${subject}`).catch(() => {});
        return;
      }

// CLOSE command changed: send an ephemeral message with select menus and a button to open modal for reason
if (cmd === 'close') {
  const code = interaction.options.getString('code', true);
  
  // Check if this is a modmail ticket (format: \d+[ACSP])
  const modmailMatch = code.match(/^(\d+)([ACSPacsp])$/i);
  if (modmailMatch) {
    // This is a modmail ticket, route to modmail close handler
    const ticketNum = modmailMatch[1];
    const letter = modmailMatch[2].toUpperCase();
    
    if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can close tickets.', ephemeral: true }).catch(() => {});
    
    // Find the modmail ticket with matching ticketNum and letter
    let foundTicket = null;
    for (const [channelId, ticket] of Object.entries(db.modmail?.byChannel || {})) {
      if (String(ticket.id) === ticketNum && String(ticket.letter).toUpperCase() === letter) {
        foundTicket = ticket;
        break;
      }
    }
    
    if (!foundTicket) {
      return interaction.reply({ content: `Modmail ticket ${ticketNum}${letter} not found.`, ephemeral: true }).catch(() => {});
    }
    
    // If this is a tutor_application ticket, start the acceptance flow
    if (foundTicket.purpose === 'tutor_application') {
      const modal = new ModalBuilder().setCustomId(`mm_close_modal|${foundTicket.channelId}`).setTitle(`Close modmail ${ticketNum}${letter}`);
      const reasonInput = new TextInputBuilder().setCustomId('mm_close_reason').setLabel('Reason for closing (optional)').setStyle(TextInputStyle.Paragraph).setRequired(false);
      modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
      try { await interaction.showModal(modal); } catch (e) { console.warn('showModal mm_close failed', e); try { notifyStaffError(e, 'modmail close modal', interaction); } catch (err) {} return; }
      return;
    }
    
    // For other modmail types, close immediately
    try {
      foundTicket.closeReason = 'Staff closed via /close command';
      await db._modmail_helpers.closeTicketByChannel(foundTicket.channelId, `${interaction.user.tag} (staff)`);
      return interaction.reply({ content: `Modmail ticket ${ticketNum}${letter} closed.`, ephemeral: true }).catch(() => {});
    } catch (e) {
      console.warn('Failed to close modmail ticket', e);
      try { notifyStaffError(e, 'modmail close', interaction); } catch (err) {}
      return interaction.reply({ content: `Failed to close modmail ticket ${ticketNum}${letter}.`, ephemeral: true }).catch(() => {});
    }
  }
  
  // Regular ticket close flow
  const ticket = db.tickets[code];
  if (!ticket) return interaction.reply({ content: `Ticket ${code} not found.`, ephemeral: true }).catch(() => {});
  if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can close tickets.', ephemeral: true }).catch(() => {});

  const components = await buildCloseFlowComponents(interaction.guild, code, ticket);
  return interaction.reply({ content: 'Please pick whether the student was hired, the tutor if yes, and the subject. Then click Provide reason and close.', components, ephemeral: true }).catch(() => {});
}

      // subject / tutor / sticky / embedcolor / editinit / help / staffhelp
      if (cmd === 'subject') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can manage subjects.', ephemeral: true }).catch(() => {});
        const action = interaction.options.getString('action', true);
        const subj = interaction.options.getString('subject', false);
        const levelRaw = interaction.options.getString('level', false);
        if (action === 'add') {
          if (!subj) return interaction.reply({ content: 'Provide subject text to add.', ephemeral: true }).catch(() => {});
          if (db.subjects.includes(subj)) return interaction.reply({ content: 'Subject already exists.', ephemeral: true }).catch(() => {});
          db.subjects.push(subj);
          if (levelRaw) {
            const levelKey = normalizeSubjectLevelKey(levelRaw) || detectLevelFromSubject(subj);
            if (levelKey) {
              if (!db.subjectLevels) db.subjectLevels = {};
              db.subjectLevels[subj] = levelKey;
            }
          }
          saveDB(); await registerCommands();
          const levelKey = (db.subjectLevels && db.subjectLevels[subj]) || detectLevelFromSubject(subj);
          return interaction.reply({ content: `Subject added: ${subj}${levelKey ? ` (level: ${levelKey})` : ' (no level set — use the level option to filter by level)'}`, ephemeral: true }).catch(() => {});
        } else if (action === 'remove') {
          if (!subj) return interaction.reply({ content: 'Provide subject text to remove.', ephemeral: true }).catch(() => {});
          db.subjects = db.subjects.filter(s => s !== subj);
          delete db.subjectTutors[subj];
          if (db.subjectLevels) delete db.subjectLevels[subj];
          saveDB(); await registerCommands(); await syncTutorsLoungeCategoryAccess();
          return interaction.reply({ content: `Subject removed: ${subj}`, ephemeral: true }).catch(() => {});
        } else {
          if (!db.subjects || db.subjects.length === 0) return interaction.reply({ content: 'No subjects found.', ephemeral: true }).catch(() => {});
          const tutorAssignedFilter = interaction.options.getString('tutor-assigned', false); // 'yes', 'no', 'all', or null
          const filterLevel = levelRaw ? (normalizeSubjectLevelKey(levelRaw) || levelRaw) : null;
          let subjectsToList = db.subjects;
          if (filterLevel) {
            subjectsToList = subjectsToList.filter(s => {
              const lvl = (db.subjectLevels && db.subjectLevels[s]) || detectLevelFromSubject(s) || 'other';
              return lvl === filterLevel;
            });
          }
          if (tutorAssignedFilter === 'yes') {
            subjectsToList = subjectsToList.filter(s => ((db.subjectTutors || {})[s] || []).length > 0);
          } else if (tutorAssignedFilter === 'no') {
            subjectsToList = subjectsToList.filter(s => ((db.subjectTutors || {})[s] || []).length === 0);
          }
          // tutorAssignedFilter === 'all' or null: no filtering by assignment
          if (subjectsToList.length === 0) {
            const filterDesc = [filterLevel ? `level: ${SUBJECT_LEVEL_LABELS[filterLevel] || filterLevel}` : null, tutorAssignedFilter === 'yes' ? 'has tutor' : tutorAssignedFilter === 'no' ? 'no tutor' : null].filter(Boolean).join(', ');
            return interaction.reply({ content: `No subjects found${filterDesc ? ` matching (${filterDesc})` : ''}.`, ephemeral: true }).catch(() => {});
          }
          const lines = subjectsToList.map(s => {
            const lvl = (db.subjectLevels && db.subjectLevels[s]) || detectLevelFromSubject(s) || '(no level)';
            const tutorCount = (db.subjectTutors[s] || []).length;
            return `${s} [${lvl}]${tutorCount ? ` (${tutorCount} tutor${tutorCount > 1 ? 's' : ''})` : ''}`;
          });
          const filterDesc = [filterLevel ? `level: ${SUBJECT_LEVEL_LABELS[filterLevel] || filterLevel}` : null, tutorAssignedFilter === 'yes' ? 'has tutor' : tutorAssignedFilter === 'no' ? 'no tutor' : null].filter(Boolean).join(', ');
          const chunks = splitMessage(`Subjects (${lines.length})${filterDesc ? ` [${filterDesc}]` : ''}:\n${lines.join('\n')}`, 1900);
          await interaction.reply({ content: chunks[0] }).catch(() => {});
          for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp({ content: chunks[i] }).catch(() => {});
          }
          return;
        }
      }

      // tutor command extended to show students and reviews
      if (cmd === 'tutor') {
        let action = null;
        try { action = interaction.options.getSubcommand(false); } catch (e) {}
        if (!action) action = interaction.options.getString('action', false);
        const userOpt = interaction.options.getUser('user', false);
        const useridRaw = userOpt ? userOpt.id : null;
        const subj = interaction.options.getString('subject', false);

        db.tutorProfiles = db.tutorProfiles || {};

        if (action === 'info') {
          if (!useridRaw) {
            // present a select of known tutors so staff don't need to type IDs
            const allTutorIds = getAllTutorIds();
            if (allTutorIds.length === 0) return interaction.reply({ content: 'No tutors in database.', ephemeral: true }).catch(() => {});
            const options = await buildTutorSelectOptions(interaction.guild, allTutorIds);
            const select = buildPaginatedSelectMenu({ baseCustomId: 'tutor_select|info', placeholder: 'Select a tutor to view info', options });
            return interaction.reply({ content: 'Select a tutor to view info:', components: [new ActionRowBuilder().addComponents(select)], ephemeral: true }).catch(() => {});
          }
          const userid = String(useridRaw);
          const subjects = [];
          for (const s of db.subjects) {
            const arr = db.subjectTutors[s] || [];
            if (arr.includes(userid)) subjects.push(s);
          }
          const profile = db.tutorProfiles[userid] || { addedAt: null, students: [], reviews: [], rating: { count: 0, avg: 0 } };
          const addedAt = profile && profile.addedAt ? `<t:${Math.floor(profile.addedAt/1000)}:f>` : '(unknown)';
          let userTag = '(not in guild)';
          let displayName = null;
          let joined = '(unknown)';
          try {
            const member = await interaction.guild.members.fetch(userid).catch(() => null);
            if (member) {
              userTag = member.user.tag;
              displayName = member.displayName;
              joined = member.joinedAt ? `<t:${Math.floor(member.joinedAt.getTime()/1000)}:f>` : '(unknown)';
            } else {
              const user = await client.users.fetch(userid).catch(() => null);
              if (user) { userTag = user.tag; displayName = user.username; }
            }
          } catch (e) {}
          const rating = profile.rating && profile.rating.count ? `${(Number(profile.rating.avg) || 0).toFixed(2)} ⭐️ (${profile.rating.count})` : '(no ratings)';
          const studentList = (profile.students && profile.students.length)
            ? (await Promise.all(profile.students.map(studentId => formatUserLabel(interaction.guild, studentId)))).join(', ')
            : '(none)';
          const notes = profile.notes || '(no notes)';
          const phone = profile.phoneNumber || '(not set)';
          const dob = profile.dob || '(not set)';
          const nameDisplay = displayName ? `**${displayName}** (<@${userid}> · \`${userTag}\`)` : `<@${userid}> · \`${userTag}\``;
          const lines = [
            `Tutor info for: ${nameDisplay} — ID: \`${userid}\``,
            `Guild joined: ${joined}`,
            `Tutor added at: ${addedAt}`,
            `Subjects: ${subjects.length ? subjects.join(', ') : '(none)'}`,
            `Assigned students: ${studentList}`,
            `Rating: ${rating}`,
            `Phone: ${phone}`,
            `DOB: ${dob}`,
            `Notes: ${notes}`
          ];
          return interaction.reply({ content: lines.join('\n') }).catch(() => {});
        }

        if (action === 'notes') {
          if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can manage tutor notes.', ephemeral: true }).catch(() => {});
          if (!useridRaw) {
            // present a select of tutors to open notes modal for
            const allTutorIds = getAllTutorIds();
            if (allTutorIds.length === 0) return interaction.reply({ content: 'No tutors in database.', ephemeral: true }).catch(() => {});
            const options = await buildTutorSelectOptions(interaction.guild, allTutorIds);
            const select = buildPaginatedSelectMenu({ baseCustomId: 'tutor_select|notes', placeholder: 'Select a tutor to edit notes', options });
            return interaction.reply({ content: 'Select a tutor to edit notes:', components: [new ActionRowBuilder().addComponents(select)], ephemeral: true }).catch(() => {});
          }

          const userid = String(useridRaw);
          db.tutorProfiles[userid] = db.tutorProfiles[userid] || { addedAt: Date.now(), students: [], reviews: [], rating: { count: 0, avg: 0 }, notes: '' };
          
          const currentNotes = db.tutorProfiles[userid].notes || '';
          
          const modal = new ModalBuilder()
            .setCustomId(`tutor_notes_modal|${userid}`)
            .setTitle(`Tutor Notes`);
          
          const notesInput = new TextInputBuilder()
            .setCustomId('tutor_notes')
            .setLabel('Notes for this tutor')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setValue(currentNotes.substring(0, 4000))
            .setPlaceholder('Enter notes about this tutor...')
            .setMaxLength(4000);
          
          modal.addComponents(new ActionRowBuilder().addComponents(notesInput));
          
          try {
            await interaction.showModal(modal);
          } catch (err) {
            console.error('showModal failed for tutor notes', err);
            try { notifyStaffError(err, 'tutor notes showModal', interaction); } catch (e) {}
            return interaction.reply({ content: 'Could not open notes modal, try again.', ephemeral: true }).catch(() => {});
          }
          return;
        }

        if (action === 'list') {
          if (subj) {
            const arr = db.subjectTutors[subj] || [];
            if (arr.length === 0) return interaction.reply({ content: `Tutors for ${subj}:\n(none)`, ephemeral: true }).catch(() => {});
            const lines = [];
            for (const id of arr) {
              let label = id;
              try {
                const m = await interaction.guild.members.fetch(id).catch(() => null);
                if (m) label = `${m.user.username} (${id})`;
                else { const u = await client.users.fetch(id).catch(() => null); if (u) label = `${u.username} (${id})`; }
              } catch (e) {}
              lines.push(label);
            }
            return interaction.reply({ content: `Tutors for ${subj}:\n${lines.join('\n')}`, ephemeral: true }).catch(() => {});
          } else {
            const lines = [];
            for (const s of (db.subjects || [])) {
              const ids = (db.subjectTutors || {})[s] || [];
              if (ids.length === 0) continue; // skip subjects with no tutors
              const formatted = [];
              for (const id of ids) {
                let label = id;
                try {
                  const m = await interaction.guild.members.fetch(id).catch(() => null);
                  if (m) label = `${m.user.username} (${id})`;
                  else { const u = await client.users.fetch(id).catch(() => null); if (u) label = `${u.username} (${id})`; }
                } catch (e) {}
                formatted.push(label);
              }
              lines.push(`${s}: ${formatted.join(', ')}`);
            }
            if (lines.length === 0) return interaction.reply({ content: 'No subjects with assigned tutors found.', ephemeral: true }).catch(() => {});
            const chunks = splitMessage(lines.join('\n'), 1900);
            await interaction.reply({ content: chunks[0], ephemeral: true }).catch(() => {});
            for (let i = 1; i < chunks.length; i++) {
              await interaction.followUp({ content: chunks[i], ephemeral: true }).catch(() => {});
            }
            return;
          }
        }

        if (action === 'edit') {
          if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can edit tutor info.', ephemeral: true }).catch(() => {});
          if (!useridRaw) {
            const allTutorIds = getAllTutorIds();
            if (allTutorIds.length === 0) return interaction.reply({ content: 'No tutors in database.', ephemeral: true }).catch(() => {});
            const options = await buildTutorSelectOptions(interaction.guild, allTutorIds);
            const select = buildPaginatedSelectMenu({ baseCustomId: 'tutor_select|edit', placeholder: 'Select a tutor to edit contact info', options });
            return interaction.reply({ content: 'Select a tutor to edit their phone number and date of birth:', components: [new ActionRowBuilder().addComponents(select)], ephemeral: true }).catch(() => {});
          }

          const userid = String(useridRaw);
          db.tutorProfiles[userid] = db.tutorProfiles[userid] || { addedAt: Date.now(), students: [], reviews: [], rating: { count: 0, avg: 0 }, notes: '' };
          const profile = db.tutorProfiles[userid];
          const modal = new ModalBuilder()
            .setCustomId(`tutor_edit_modal|${userid}`)
            .setTitle('Edit Tutor Contact Info');
          const phoneInput = new TextInputBuilder()
            .setCustomId('phone').setLabel('Phone Number').setStyle(TextInputStyle.Short)
            .setRequired(false).setValue((profile.phoneNumber || '').substring(0, 100)).setPlaceholder('e.g. +1 234 567 890');
          const dobInput = new TextInputBuilder()
            .setCustomId('dob').setLabel('Date of Birth').setStyle(TextInputStyle.Short)
            .setRequired(false).setValue((profile.dob || '').substring(0, 100)).setPlaceholder('e.g. YYYY-MM-DD');
          modal.addComponents(new ActionRowBuilder().addComponents(phoneInput), new ActionRowBuilder().addComponents(dobInput));
          try {
            await interaction.showModal(modal);
          } catch (err) {
            console.error('showModal failed for tutor edit', err);
            return interaction.reply({ content: 'Could not open edit modal, try again.', ephemeral: true }).catch(() => {});
          }
          return;
        }

        // If removing and no userid was given, present subject+tutor selects when both missing,
        // or subject-specific tutor select when subject provided.
        if (action === 'remove' && !useridRaw) {
          // If no subject provided, show both subject select and tutor select (all known tutors)
          if (!subj) {
            const rows = [];

            // Subject select
            const subjOptions = buildSubjectSelectOptions(db.subjects || []);
            if (subjOptions.length) {
              const subjectSelect = buildPaginatedSelectMenu({ baseCustomId: 'tutor_remove_select|subject', placeholder: 'Select subject to remove tutor from', options: subjOptions });
              rows.push(new ActionRowBuilder().addComponents(subjectSelect));
            }

            // Tutor select - include tutors present in db.subjectTutors
            const tutorOptions = await buildTutorSelectOptions(interaction.guild, getAllTutorIds());
            if (tutorOptions.length) {
              const tutorSelect = buildPaginatedSelectMenu({ baseCustomId: 'tutor_remove_select|tutor', placeholder: 'Select tutor to remove', options: tutorOptions });
              rows.push(new ActionRowBuilder().addComponents(tutorSelect));
            }

            if (!rows.length) return interaction.reply({ content: 'No subjects or tutors available to remove.', ephemeral: true }).catch(() => {});
            return interaction.reply({ content: 'Select subject and tutor to remove:', components: rows, ephemeral: true }).catch(() => {});
          }

          // If subject provided, show tutors for that subject only
          const arr = db.subjectTutors[subj] || [];
          if (!arr.length) return interaction.reply({ content: `No tutors for subject ${subj}.`, ephemeral: true }).catch(() => {});
          const options = await buildTutorSelectOptions(interaction.guild, arr.map(id => String(id)));
          const select = buildPaginatedSelectMenu({ baseCustomId: `tutor_remove_select|tutor|${subj}`, placeholder: 'Select tutor to remove from subject', options });
          return interaction.reply({ content: `Select a tutor to remove from ${subj}:`, components: [new ActionRowBuilder().addComponents(select)], ephemeral: true }).catch(() => {});
        }

        if (!isStaff(interaction.member)) {
          return interaction.reply({ content: 'Only staff can manage tutors.', ephemeral: true }).catch(() => {});
        }

        // When /tutor remove user:@X is used without a subject: show only that tutor's subjects
        if (action === 'remove' && useridRaw && !subj) {
          const userid = String(useridRaw);
          const tutorSubjects = Object.entries(db.subjectTutors || {})
            .filter(([, ids]) => ids.includes(userid))
            .map(([s]) => s);
          if (tutorSubjects.length === 0) {
            return interaction.reply({ content: `<@${userid}> is not assigned to any subjects.`, ephemeral: true }).catch(() => {});
          }
          // Store the userid in _tempTutorRemove so the select handler can complete the removal
          db._tempTutorRemove = db._tempTutorRemove || {};
          const key = interaction.user.id;
          db._tempTutorRemove[key] = { subject: null, userid };
          saveDB();
          const subjectSelect = buildPaginatedSelectMenu({
            baseCustomId: 'tutor_remove_select|subject',
            placeholder: 'Select subject to remove tutor from',
            options: buildSubjectSelectOptions(tutorSubjects)
          });
          return interaction.reply({
            content: `Select the subject to remove <@${userid}> from:`,
            components: [new ActionRowBuilder().addComponents(subjectSelect)],
            ephemeral: true
          }).catch(() => {});
        }

        // If add/remove called without both userid and subject, present selection UI
        if (!useridRaw || !subj) {
          // Prepare temp storage for this staff user
          db._tempTutorAdd = db._tempTutorAdd || {};
          const key = interaction.user.id;
          db._tempTutorAdd[key] = db._tempTutorAdd[key] || { subject: null, userid: null };
          if (subj) db._tempTutorAdd[key].subject = subj;
          if (useridRaw) db._tempTutorAdd[key].userid = String(useridRaw);
          saveDB();

          // For the add flow with no subject: show level dropdown first, then filtered subjects
          if (action === 'add' && !subj) {
            if (!useridRaw) {
              return interaction.reply({ content: 'Please mention or select the tutor using the `user` option, e.g. `/tutor add user:@username`.', ephemeral: true }).catch(() => {});
            }
            const levelOptions = [
              new StringSelectMenuOptionBuilder().setLabel('University').setValue('university'),
              new StringSelectMenuOptionBuilder().setLabel('A Level').setValue('a_level'),
              new StringSelectMenuOptionBuilder().setLabel('IGCSE').setValue('igcse'),
              new StringSelectMenuOptionBuilder().setLabel('Below IGCSE').setValue('below_igcse'),
              new StringSelectMenuOptionBuilder().setLabel('Language').setValue('language'),
              new StringSelectMenuOptionBuilder().setLabel('Test Prep').setValue('test_prep'),
              new StringSelectMenuOptionBuilder().setLabel('Other').setValue('other')
            ];
            const levelSelect = new StringSelectMenuBuilder()
              .setCustomId(`tutor_add_level|${interaction.user.id}`)
              .setPlaceholder('Select subject level category')
              .addOptions(levelOptions);
            const tutorMention = userOpt ? `<@${userOpt.id}>` : useridRaw;
            return interaction.reply({ content: `Adding tutor ${tutorMention} — **Step 1:** Select the subject level to filter subjects:`, components: [new ActionRowBuilder().addComponents(levelSelect)] }).catch(() => {});
          }

          const rows = [];

          // Subject select if subject not provided (for remove flow)
          if (!subj) {
            const subjOptions = buildSubjectSelectOptions(db.subjects || []);
            if (subjOptions.length === 0) return interaction.reply({ content: 'No subjects available. Please add subjects first using /subject add', ephemeral: true }).catch(() => {});
            const subjectCustomId = action === 'remove' ? 'tutor_remove_select|subject' : 'tutor_add_select|subject';
            const subjectSelect = buildPaginatedSelectMenu({
              baseCustomId: subjectCustomId,
              placeholder: action === 'remove' ? 'Select subject to remove tutor from' : 'Select subject to add tutor to',
              options: subjOptions
            });
            rows.push(new ActionRowBuilder().addComponents(subjectSelect));
          }

          // Tutor select if userid not provided (only for remove flow; add flow requires USER option)
          if (!useridRaw && action === 'remove') {
            const options = await buildTutorSelectOptions(interaction.guild, getAllTutorIds());
            if (options.length) {
              const tutorSelect = buildPaginatedSelectMenu({ baseCustomId: 'tutor_remove_select|tutor', placeholder: 'Select tutor to remove', options });
              rows.push(new ActionRowBuilder().addComponents(tutorSelect));
            }
          }

          if (!rows.length) return interaction.reply({ content: 'Nothing to select. Provide both `user` and `subject` options.', ephemeral: true }).catch(() => {});
          return interaction.reply({ content: 'Select subject and/or tutor (your selections will be saved).', components: rows, ephemeral: true }).catch(() => {});
        }

        const userid = String(useridRaw);
        const tutorMentionFmt = userOpt ? `**${userOpt.username}** (<@${userid}>)` : `<@${userid}>`;
        db.subjectTutors[subj] = db.subjectTutors[subj] || [];

        if (action === 'add') {
          if (db.subjectTutors[subj].includes(userid)) {
            return interaction.reply({ content: `${tutorMentionFmt} is already added for **${subj}**.`, ephemeral: true }).catch(() => {});
          }

          db.subjectTutors[subj].push(userid);
          db.tutorProfiles[userid] = db.tutorProfiles[userid] || { addedAt: Date.now(), students: [], reviews: [], rating: { count:0, avg:0 }, notes: '' };
          saveDB();

          // Start grantTutorAccess in background before showing modal
          (async () => {
            try {
              await grantTutorAccess(userid);
              console.log(`grantTutorAccess: finished for ${userid}`);
            } catch (e) {
              console.warn(`grantTutorAccess async failed for ${userid}`, e);
              try { notifyStaffError(e, 'grantTutorAccess async', interaction); } catch (err) {}
            }
          })();

          // Show phone/DOB modal as the response to the slash command
          const profile = db.tutorProfiles[userid];
          const addModal = new ModalBuilder()
            .setCustomId(`tutor_add_info_modal|${userid}`)
            .setTitle('New Tutor — Contact Info (Optional)');
          const phoneInput = new TextInputBuilder()
            .setCustomId('phone').setLabel('Phone Number').setStyle(TextInputStyle.Short)
            .setRequired(false).setValue((profile.phoneNumber || '').substring(0, 100)).setPlaceholder('e.g. +1 234 567 890');
          const dobInput = new TextInputBuilder()
            .setCustomId('dob').setLabel('Date of Birth').setStyle(TextInputStyle.Short)
            .setRequired(false).setValue((profile.dob || '').substring(0, 100)).setPlaceholder('e.g. YYYY-MM-DD');
          addModal.addComponents(new ActionRowBuilder().addComponents(phoneInput), new ActionRowBuilder().addComponents(dobInput));
          try {
            await interaction.showModal(addModal);
          } catch (err) {
            console.error('showModal failed for tutor add info', err);
            try { await interaction.reply({ content: `Added tutor ${tutorMentionFmt} to **${subj}**, access grant started.` }); } catch (e) { try { await interaction.followUp({ content: `Added tutor ${tutorMentionFmt} to **${subj}**, access grant started.` }); } catch {} }
          }
          return;
        }

        if (action === 'remove') {
          db.subjectTutors[subj] = db.subjectTutors[subj].filter(id => id !== userid);
          saveDB();
          try {
            await revokeTutorAccess(userid);
          } catch (e) { console.warn('revokeTutorAccess failed', e); try { notifyStaffError(e, 'revokeTutorAccess', interaction); } catch (err) {} }
          const tutorUser = await client.users.fetch(userid).catch(() => null);
          const tutorDisplay = tutorUser ? `${tutorUser.username} (${userid})` : userid;
          return interaction.reply({ content: `Removed tutor ${tutorDisplay} from ${subj}, access revoked.`, ephemeral: true }).catch(() => {});
        }

        return interaction.reply({ content: 'Unknown action for tutor.', ephemeral: true }).catch(() => {});
      }

      if (cmd === 'tutoredit') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can edit tutor info.', ephemeral: true }).catch(() => {});
        const userOpt = interaction.options.getUser('user', false);
        const useridRaw = userOpt ? userOpt.id : null;

        db.tutorProfiles = db.tutorProfiles || {};

        if (!useridRaw) {
          // Show a select menu to pick a tutor
          const allTutorIds = getAllTutorIds();
          if (allTutorIds.length === 0) return interaction.reply({ content: 'No tutors in database.', ephemeral: true }).catch(() => {});
          const options = await buildTutorSelectOptions(interaction.guild, allTutorIds);
          const select = buildPaginatedSelectMenu({ baseCustomId: 'tutor_select|edit', placeholder: 'Select a tutor to edit contact info', options });
          return interaction.reply({ content: 'Select a tutor to edit their phone number and date of birth:', components: [new ActionRowBuilder().addComponents(select)], ephemeral: true }).catch(() => {});
        }

        const userid = String(useridRaw);
        db.tutorProfiles[userid] = db.tutorProfiles[userid] || { addedAt: Date.now(), students: [], reviews: [], rating: { count: 0, avg: 0 }, notes: '' };
        const profile = db.tutorProfiles[userid];
        const modal = new ModalBuilder()
          .setCustomId(`tutor_edit_modal|${userid}`)
          .setTitle('Edit Tutor Contact Info');
        const phoneInput = new TextInputBuilder()
          .setCustomId('phone').setLabel('Phone Number').setStyle(TextInputStyle.Short)
          .setRequired(false).setValue((profile.phoneNumber || '').substring(0, 100)).setPlaceholder('e.g. +1 234 567 890');
        const dobInput = new TextInputBuilder()
          .setCustomId('dob').setLabel('Date of Birth').setStyle(TextInputStyle.Short)
          .setRequired(false).setValue((profile.dob || '').substring(0, 100)).setPlaceholder('e.g. YYYY-MM-DD');
        modal.addComponents(new ActionRowBuilder().addComponents(phoneInput), new ActionRowBuilder().addComponents(dobInput));
        try {
          await interaction.showModal(modal);
        } catch (err) {
          console.error('showModal failed for tutoredit', err);
          return interaction.reply({ content: 'Could not open edit modal, try again.', ephemeral: true }).catch(() => {});
        }
        return;
      }


      // sticky command shows modal (prefill)
      if (cmd === 'sticky') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can set sticky message.', ephemeral: true }).catch(() => {});
        const modal = new ModalBuilder().setCustomId('sticky_modal').setTitle('Set sticky message');
        const titleInput = new TextInputBuilder().setCustomId('sticky_title').setLabel('Sticky title').setStyle(TextInputStyle.Short).setRequired(false).setValue((db.sticky?.title || '').substring(0, 100));
        const bodyInput = new TextInputBuilder().setCustomId('sticky_body').setLabel('Sticky body').setStyle(TextInputStyle.Paragraph).setRequired(true).setValue((db.sticky?.body || '').substring(0, 4000));
        modal.addComponents(new ActionRowBuilder().addComponents(titleInput), new ActionRowBuilder().addComponents(bodyInput));
        return interaction.showModal(modal).catch(() => {});
      }

      // embedcolor
      if (cmd === 'embedcolor') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can set embed color.', ephemeral: true }).catch(() => {});
        const hex = interaction.options.getString('hex', true);

        db.defaultEmbedColor = hex;
        saveDB();

        if (db.sticky) {
          db.sticky.color = hex;
          saveDB();
          try {
            const findChannel = await interaction.guild.channels.fetch(FIND_A_TUTOR_CHANNEL_ID).catch(() => null);
            if (findChannel) {
              await repostStickyInChannel(findChannel);
            }
          } catch (e) {
            console.warn('reposting sticky after embedcolor failed', e);
            try { notifyStaffError(e, 'embedcolor repostSticky', interaction); } catch (err) {}
          }
        }

        return interaction.reply({ content: `Default embed color set to ${hex}`, ephemeral: true }).catch(() => {});
      }

      // editinit command now opens modal with prefilled value
      if (cmd === 'editinit') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can edit init message.', ephemeral: true }).catch(() => {});
        const modal = new ModalBuilder().setCustomId('editinit_modal').setTitle('Edit initial ticket message');
        const initInput = new TextInputBuilder()
          .setCustomId('init_message')
          .setLabel('Initial message, use {subject}')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setValue((db.initMessage || '').substring(0, 4000));
        modal.addComponents(new ActionRowBuilder().addComponents(initInput));
        return interaction.showModal(modal).catch(() => {});
      }

      if (cmd === 'help') return interaction.reply({ content: `Commands:\n/enquire subject:<choice>\n/ad create|edit|delete\n/tutor info|list\n/student list\n/keyword set|list|remove\n/help\n/bumpleaderboard`, ephemeral: true }).catch(() => {});

      if (cmd === 'keyword') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can set keyword responses.', ephemeral: true }).catch(() => {});
        let action = null;
        try { action = interaction.options.getSubcommand(false); } catch (e) {}
        if (!action) action = interaction.options.getString('action', false);

        db.keywordAutomations = normalizeKeywordAutomations(db.keywordAutomations);

        if (action === 'list') {
          if (!db.keywordAutomations.length) {
            return interaction.reply({ content: 'No keyword responses are configured.', ephemeral: true }).catch(() => {});
          }

          const lines = db.keywordAutomations.map((entry, index) => {
            const responsePreview = entry.response.length > 80 ? `${entry.response.slice(0, 77)}...` : entry.response;
            return `${index + 1}. **${entry.keyword}** -> ${responsePreview}`;
          });
          const chunks = splitMessage(`Keyword responses (${db.keywordAutomations.length}):\n${lines.join('\n')}`, 1900);
          await interaction.reply({ content: chunks[0], ephemeral: true }).catch(() => {});
          for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp({ content: chunks[i], ephemeral: true }).catch(() => {});
          }
          return;
        }

        if (action === 'remove') {
          const keyword = String(interaction.options.getString('keyword', true) || '').trim();
          if (!keyword) return interaction.reply({ content: 'Please provide a keyword to remove.', ephemeral: true }).catch(() => {});

          const before = db.keywordAutomations.length;
          db.keywordAutomations = db.keywordAutomations.filter(entry => String(entry.keyword || '').toLowerCase() !== keyword.toLowerCase());
          if (db.keywordAutomations.length === before) {
            return interaction.reply({ content: `No keyword response matched **${keyword}**.`, ephemeral: true }).catch(() => {});
          }

          saveDB();
          return interaction.reply({ content: `Removed keyword response for **${keyword}**.`, ephemeral: true }).catch(() => {});
        }

        const keyword = String(interaction.options.getString('keyword', true) || '').trim();
        const response = String(interaction.options.getString('response', true) || '').trim();
        if (!keyword) return interaction.reply({ content: 'Please provide a keyword to watch for.', ephemeral: true }).catch(() => {});
        if (!response) return interaction.reply({ content: 'Please provide a response message.', ephemeral: true }).catch(() => {});

        const normalizedKeyword = keyword.substring(0, 100);
        const normalizedResponse = response.substring(0, 2000);
        const existingIndex = db.keywordAutomations.findIndex(entry => String(entry.keyword || '').toLowerCase() === normalizedKeyword.toLowerCase());
        const entry = { keyword: normalizedKeyword, response: normalizedResponse, createdAt: Date.now(), createdBy: interaction.user.id };
        if (existingIndex >= 0) db.keywordAutomations[existingIndex] = entry;
        else db.keywordAutomations.push(entry);
        saveDB();

        return interaction.reply({ content: `Keyword trigger set to **${normalizedKeyword}**. The bot will now respond when it appears in a message.`, ephemeral: true }).catch(() => {});
      }

      if (cmd === 'staffhelp') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can access this.', ephemeral: true }).catch(() => {});
        return interaction.reply({ content: `Staff Commands:\n/subject add/remove/list [level] [tutor-assigned:yes/no/all]\n/tutor add/remove/list/info/notes/edit [user:@mention]\n/ad create|edit|delete\n/keyword set|list|remove\n/aichannel set\n/sticky\n/embedcolor\n/editinit\n/close\n/student add/remove/list [filters]\n/modmailmap [purpose/category]\n/reviewreminder\n/seedsubjects`, ephemeral: true }).catch(() => {});
      }

      if (cmd === 'aichannel') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can configure Alvey Assistant.', ephemeral: true }).catch(() => {});
        let action = null;
        try { action = interaction.options.getSubcommand(false); } catch (e) {}
        if (action !== 'set') return interaction.reply({ content: 'Use `/aichannel set channel:#channel`.', ephemeral: true }).catch(() => {});
        const channel = interaction.options.getChannel('channel', true);
        if (!channel || channel.type !== ChannelType.GuildText) {
          return interaction.reply({ content: 'Please choose a public text channel.', ephemeral: true }).catch(() => {});
        }
        db.aiChannelId = channel.id;
        saveDB();
        return interaction.reply({ content: `Alvey Assistant will now respond to mentions in <#${channel.id}>.`, ephemeral: true }).catch(() => {});
      }

      // bumpleaderboard command
      if (cmd === 'bumpleaderboard') {
        if (!db.bumpLeaderboard || Object.keys(db.bumpLeaderboard).length === 0) {
          return interaction.reply({ content: 'No bumps tracked yet! Use `/bump` to bump the server and start tracking.', ephemeral: false }).catch(() => {});
        }

        // Sort users by bump count (descending)
        const sorted = Object.entries(db.bumpLeaderboard)
          .map(([userId, data]) => ({ userId, count: data.count || 0, lastBump: data.lastBump || 0 }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 10); // Top 10

        if (sorted.length === 0) {
          return interaction.reply({ content: 'No bumps tracked yet! Use `/bump` to bump the server and start tracking.', ephemeral: false }).catch(() => {});
        }

        // Build leaderboard embed
        const embed = new EmbedBuilder()
          .setTitle('🏆 Bump Leaderboard')
          .setDescription('Top bumpers in the server!')
          .setColor(0x5865F2) // Discord blurple
          .setTimestamp();

        let leaderboardText = '';
        for (let i = 0; i < sorted.length; i++) {
          const { userId, count } = sorted[i];
          const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
          try {
            const user = await client.users.fetch(userId).catch(() => null);
            const username = user ? user.username : `Unknown (${userId})`;
            leaderboardText += `${medal} **${username}** - ${count} bump${count !== 1 ? 's' : ''}\n`;
          } catch (e) {
            leaderboardText += `${medal} <@${userId}> - ${count} bump${count !== 1 ? 's' : ''}\n`;
          }
        }

        embed.setDescription(leaderboardText || 'No bumps tracked yet!');

        return interaction.reply({ embeds: [embed], ephemeral: false }).catch(() => {});
      }

      // STUDENT command: add/remove
      if (cmd === 'student') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can manage students.', ephemeral: true }).catch(() => {});
        let action = null;
        try { action = interaction.options.getSubcommand(false); } catch (e) {}
        if (!action) action = interaction.options.getString('action', false);
        const studentUser = interaction.options.getUser('student', false);
        const tutorUser = interaction.options.getUser('tutor', false);
        const subject = interaction.options.getString('subject', false) || '(unspecified)';

        if (action === 'list') {
          const tutorFilter = tutorUser?.id || null;
          const subjectFilter = interaction.options.getString('subject', false) || null;
          const assignments = Object.entries(db.studentAssignments || {})
            .filter(([, asg]) => {
              if (!asg) return false;
              if (tutorFilter && String(asg.tutorId) !== String(tutorFilter)) return false;
              if (subjectFilter && String(asg.subject || '') !== String(subjectFilter)) return false;
              return true;
            })
            .sort((a, b) => {
              const aSubj = String(a[1]?.subject || '').toLowerCase();
              const bSubj = String(b[1]?.subject || '').toLowerCase();
              if (aSubj !== bSubj) return aSubj.localeCompare(bSubj);
              return String(a[0]).localeCompare(String(b[0]));
            });

          if (assignments.length === 0) {
            const filters = [
              tutorFilter ? `tutor ${await formatUserLabel(interaction.guild, tutorFilter)}` : null,
              subjectFilter ? `subject ${subjectFilter}` : null
            ].filter(Boolean).join(', ');
            return interaction.reply({ content: `No student assignments found${filters ? ` for ${filters}` : ''}.`, ephemeral: true }).catch(() => {});
          }

          const lines = [];
          for (const [studentId, asg] of assignments) {
            const studentLabel = await formatUserLabel(interaction.guild, studentId);
            const tutorLabel = await formatUserLabel(interaction.guild, asg.tutorId);
            const assignedAt = asg.assignedAt ? `<t:${Math.floor(asg.assignedAt / 1000)}:f>` : '(unknown)';
            lines.push(`${studentLabel} -> ${tutorLabel} [${asg.subject || '(unspecified)'}]${assignedAt ? ` since ${assignedAt}` : ''}`);
          }

          const filters = [
            tutorFilter ? `tutor ${await formatUserLabel(interaction.guild, tutorFilter)}` : null,
            subjectFilter ? `subject ${subjectFilter}` : null
          ].filter(Boolean).join(', ');
          const chunks = splitMessage(`Student assignments (${lines.length})${filters ? ` [${filters}]` : ''}:\n${lines.join('\n')}`, 1900);
          await interaction.reply({ content: chunks[0], ephemeral: true }).catch(() => {});
          for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp({ content: chunks[i], ephemeral: true }).catch(() => {});
          }
          return;
        }

        const studentId = studentUser?.id || resolveDiscordUserInput(interaction.options.getString('studentid', false)).userId;
        const tutorId = tutorUser?.id || resolveDiscordUserInput(interaction.options.getString('tutorid', false)).userId;

        if (!studentId || !tutorId) {
          return interaction.reply({ content: 'Please choose both a student and a tutor from the Discord pickers.', ephemeral: true }).catch(() => {});
        }

        if (!db.tutorProfiles[tutorId]) db.tutorProfiles[tutorId] = { addedAt: Date.now(), students: [], reviews: [], rating: { count:0, avg:0 }, notes: '' };
        const studentLabel = studentUser ? `${studentUser.username} (<@${studentId}>)` : `<@${studentId}>`;
        const tutorLabel = tutorUser ? `${tutorUser.username} (<@${tutorId}>)` : `<@${tutorId}>`;

        if (action === 'add') {
          if (!db.tutorProfiles[tutorId].students) db.tutorProfiles[tutorId].students = [];
          if (!db.tutorProfiles[tutorId].students.includes(studentId)) db.tutorProfiles[tutorId].students.push(studentId);
          db.studentAssignments[studentId] = { tutorId, subject, assignedAt: Date.now(), reviewScheduledAt: Date.now() + (db.reviewConfig.delaySeconds || 1296000)*1000 };
          saveDB();
          return interaction.reply({ content: `Student ${studentLabel} assigned to tutor ${tutorLabel} for ${subject}`, ephemeral: true }).catch(() => {});
        } else if (action === 'remove') {
          if (db.tutorProfiles[tutorId] && db.tutorProfiles[tutorId].students) db.tutorProfiles[tutorId].students = db.tutorProfiles[tutorId].students.filter(s => s !== studentId);
          if (db.studentAssignments[studentId] && db.studentAssignments[studentId].tutorId === tutorId) delete db.studentAssignments[studentId];
          saveDB();
          return interaction.reply({ content: `Student ${studentLabel} removed from tutor ${tutorLabel}`, ephemeral: true }).catch(() => {});
        }

        return interaction.reply({ content: 'Unknown student action.', ephemeral: true }).catch(() => {});
      }

      // reviewreminder - simple setter
            if (cmd === 'reviewreminder') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can change review reminder.', ephemeral: true }).catch(() => {});
        const seconds = Number(interaction.options.getString('seconds', true));
        if (!seconds || seconds <= 0) return interaction.reply({ content: 'Provide a positive number of seconds.', ephemeral: true }).catch(() => {});
        db.reviewConfig.delaySeconds = Math.max(1, Math.floor(seconds));
        saveDB();
        return interaction.reply({ content: `Review reminder set to ${db.reviewConfig.delaySeconds} second(s).`, ephemeral: true }).catch(() => {});
      }

      if (cmd === 'seedsubjects') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can seed subjects.', ephemeral: true }).catch(() => {});
        const dryRun = interaction.options.getBoolean('dryrun') || false;

        // Hardcoded seed data derived from the IGCSE Tutors and AS/A Level Tutors channel exports.
        // IGCSE channels use the `ig-` prefix; AS/AL channels use the `asl-al-` prefix.
        // Display names: strip the channel prefix, title-case, then prepend the level label.
        // Acronyms (ICT) are preserved via an explicit lookup.
        const ACRONYMS = new Set(['ict']);
        function toTitleCase(str) {
          return str.split(' ').map(w => {
            if (ACRONYMS.has(w.toLowerCase())) return w.toUpperCase();
            return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
          }).join(' ');
        }

        const SEED_SUBJECTS = [
          // --- IGCSE/GCSE ---
          { channelSlug: 'ig-accounting',                    level: 'igcse' },
          { channelSlug: 'ig-add-maths',                     level: 'igcse' },
          { channelSlug: 'ig-arabic',                        level: 'igcse' },
          { channelSlug: 'ig-art-and-design',                level: 'igcse' },
          { channelSlug: 'ig-biology',                       level: 'igcse' },
          { channelSlug: 'ig-business-studies',              level: 'igcse' },
          { channelSlug: 'ig-chemistry',                     level: 'igcse' },
          { channelSlug: 'ig-combined-coordinate-sciences',  level: 'igcse' },
          { channelSlug: 'ig-computer-science',              level: 'igcse' },
          { channelSlug: 'ig-design-and-technology',         level: 'igcse' },
          { channelSlug: 'ig-economics',                     level: 'igcse' },
          { channelSlug: 'ig-english-literature',            level: 'igcse' },
          { channelSlug: 'ig-english-second-language',       level: 'igcse' },
          { channelSlug: 'ig-environmental-management',      level: 'igcse' },
          { channelSlug: 'ig-first-language-english',        level: 'igcse' },
          { channelSlug: 'ig-french',                        level: 'igcse' },
          { channelSlug: 'ig-geography',                     level: 'igcse' },
          { channelSlug: 'ig-german',                        level: 'igcse' },
          { channelSlug: 'ig-global-perspectives',           level: 'igcse' },
          { channelSlug: 'ig-hindi',                         level: 'igcse' },
          { channelSlug: 'ig-history',                       level: 'igcse' },
          { channelSlug: 'ig-ict',                           level: 'igcse' },
          { channelSlug: 'ig-islamiyat',                     level: 'igcse' },
          { channelSlug: 'ig-malay',                         level: 'igcse' },
          { channelSlug: 'mandarin-chinese',                 level: 'igcse' },  // server channel is "mandarin-chinese" (no ig- prefix) → display: "IGCSE/GCSE Mandarin Chinese"
          { channelSlug: 'ig-maths',                         level: 'igcse' },
          { channelSlug: 'ig-music',                         level: 'igcse' },
          { channelSlug: 'ig-other-languages',               level: 'igcse' },
          { channelSlug: 'ig-pakistan-studies',              level: 'igcse' },
          { channelSlug: 'ig-physical-education',            level: 'igcse' },
          { channelSlug: 'ig-physics',                       level: 'igcse' },
          { channelSlug: 'ig-psychology',                    level: 'igcse' },
          { channelSlug: 'ig-sociology',                     level: 'igcse' },
          { channelSlug: 'ig-travel-and-tourism',            level: 'igcse' },
          { channelSlug: 'ig-urdu',                          level: 'igcse' },
          // --- AS/A Level ---
          { channelSlug: 'asl-al-accounting',                level: 'a_level' },
          { channelSlug: 'asl-al-biology',                   level: 'a_level' },
          { channelSlug: 'asl-al-business',                  level: 'a_level' },
          { channelSlug: 'asl-al-computer-science',          level: 'a_level' },
          { channelSlug: 'asl-al-economics',                 level: 'a_level' },
          { channelSlug: 'asl-al-further-maths',             level: 'a_level' },
          { channelSlug: 'asl-al-history',                   level: 'a_level' },
          { channelSlug: 'asl-al-information-technology',    level: 'a_level' },
          { channelSlug: 'asl-al-law',                       level: 'a_level' },
          { channelSlug: 'asl-al-maths',                     level: 'a_level' },
          { channelSlug: 'other-asl-al-subjects',            level: 'a_level' },  // non-standard slug → display: "AS/AL Other Subjects" (kept for backward compat)
          { channelSlug: 'asl-al-physics',                   level: 'a_level' },
          { channelSlug: 'asl-al-psychology',                level: 'a_level' },
        ];

        // Convert channel slug → display name
        function slugToDisplayName(slug, level) {
          // Strip level channel prefix
          let bare = slug
            .replace(/^ig-/, '')
            .replace(/^asl-al-/, '')
            .replace(/^other-asl-al-/, 'other ')  // e.g. "other-asl-al-subjects" → "other subjects"
            .replace(/-/g, ' ');
          bare = toTitleCase(bare);
          if (level === 'igcse') return `IGCSE/GCSE ${bare}`;
          if (level === 'a_level') return `AS/AL ${bare}`;
          return bare;
        }

        if (!db.subjects) db.subjects = [];
        if (!db.subjectLevels) db.subjectLevels = {};

        const added = [];
        const skipped = [];
        for (const { channelSlug, level } of SEED_SUBJECTS) {
          const displayName = slugToDisplayName(channelSlug, level);
          if (db.subjects.includes(displayName)) {
            // Update level mapping even if subject already exists
            if (!db.subjectLevels[displayName]) {
              db.subjectLevels[displayName] = level;
              if (!dryRun) skipped.push(`${displayName} (level updated)`);
              else skipped.push(`${displayName} (exists, would update level)`);
            } else {
              skipped.push(`${displayName} (already exists)`);
            }
          } else {
            added.push({ displayName, level });
            if (!dryRun) {
              db.subjects.push(displayName);
              db.subjectLevels[displayName] = level;
            }
          }
        }

        if (!dryRun && added.length > 0) {
          saveDB();
          await registerCommands();
        }

        const lines = [
          dryRun ? '**DRY RUN — no changes saved**' : null,
          added.length > 0 ? `**Added (${added.length}):**\n${added.map(s => `• ${s.displayName} [${s.level}]`).join('\n')}` : 'No new subjects to add.',
          skipped.length > 0 ? `**Skipped (${skipped.length}):**\n${skipped.map(s => `• ${s}`).join('\n')}` : null,
        ].filter(Boolean).join('\n\n');

        // Split into chunks to stay within Discord's 2000-char limit
        const chunks = splitMessage(lines, 1900);
        await interaction.reply({ content: chunks[0], ephemeral: true }).catch(() => {});
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp({ content: chunks[i], ephemeral: true }).catch(() => {});
        }
        return;
      }

      if (cmd === 'modmailmap') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can configure modmail mappings.', ephemeral: true }).catch(() => {});
        const purpose = interaction.options.getString('purpose', true);
        const category = interaction.options.getChannel('category', true);
        if (!category || category.type !== ChannelType.GuildCategory) {
          return interaction.reply({ content: 'Please choose a Discord category channel.', ephemeral: true }).catch(() => {});
        }

        db.modmail = db.modmail || {};
        db.modmail.config = db.modmail.config || {};
        if (purpose === 'default') {
          db.modmail.config.defaultCategoryId = category.id;
        } else {
          db.modmail.config.purposeCategories = db.modmail.config.purposeCategories || {};
          db.modmail.config.purposeCategories[purpose] = category.id;
        }
        saveDB();

        const purposeLabel = purpose === 'default' ? 'default modmail category' : `purpose ${purpose.replace(/_/g, ' ')}`;
        return interaction.reply({ content: `Mapped ${purposeLabel} to **${category.name}**.`, ephemeral: true }).catch(() => {});
      }

      if (cmd === 'exportchannels') {
        if (!isStaff(interaction.member)) return interaction.reply({ content: 'Only staff can use this command.', ephemeral: true }).catch(() => {});
        await interaction.deferReply({ ephemeral: true }).catch(err => console.warn('exportchannels: deferReply failed', err));

        const guild = interaction.guild;
        const allChannels = guild.channels.cache;

        // Build category map
        const categoriesMap = {};
        for (const [id, ch] of allChannels) {
          if (ch.type === ChannelType.GuildCategory) {
            categoriesMap[id] = { id, name: ch.name, position: ch.position ?? null, channels: [] };
          }
        }
        const uncategorizedChannels = [];

        for (const [id, ch] of allChannels) {
          if (ch.type === ChannelType.GuildCategory) continue;
          const entry = { id, name: ch.name, type: ch.type, parentId: ch.parentId || null, position: ch.position ?? null };
          if (ch.parentId && categoriesMap[ch.parentId]) {
            categoriesMap[ch.parentId].channels.push(entry);
          } else {
            uncategorizedChannels.push(entry);
          }
        }

        // Sort channels within each category by position
        for (const cat of Object.values(categoriesMap)) {
          cat.channels.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
        }
        uncategorizedChannels.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

        const output = {
          guildId: guild.id,
          guildName: guild.name,
          exportedAt: new Date().toISOString(),
          categories: Object.values(categoriesMap).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
          uncategorized: uncategorizedChannels
        };

        const json = JSON.stringify(output, null, 2);

        // Try to send as a file attachment; fall back to chunked text
        try {
          const buf = Buffer.from(json, 'utf8');
          const attachment = new AttachmentBuilder(buf, { name: 'channels-export.json' });
          return interaction.editReply({ files: [attachment] }).catch(() => {});
        } catch (e) {
          console.warn('exportchannels: attachment send failed, falling back to chunked text', e);
          const chunks = [];
          for (let i = 0; i < json.length; i += 1900) chunks.push(json.slice(i, i + 1900));
          await interaction.editReply({ content: `\`\`\`json\n${chunks[0]}\n\`\`\`` });
          for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp({ content: `\`\`\`json\n${chunks[i]}\n\`\`\``, ephemeral: true });
          }
          return;
        }
      }
    }
  } catch (err) {
    console.error('interaction error', err);
    try { await notifyStaffError(err, 'interactionCreate', interaction); } catch (e) { console.warn('notifyStaffError failed', e); }
    try {
      if (interaction && !interaction.replied && !interaction.deferred) await interaction.reply({ content: 'An error occurred, staff have been notified.', ephemeral: true });
      else if (interaction && !interaction.replied) await interaction.followUp({ content: 'An error occurred, staff have been notified.', ephemeral: true });
    } catch (e) { /* ignore */ }
  }
});

// messageCreate handler — tickets, sticky repost on normal messages, tutors feed policing
client.on('messageCreate', async (message) => {
  try {
    // Check for Disboard bump success messages (Disboard bot ID: 302050872383242240)
    const DISBOARD_BOT_ID = '302050872383242240';
    if (message.author?.id === DISBOARD_BOT_ID) {
      // Check if we should only listen in a specific channel
      if (BUMP_CHANNEL_ID && String(message.channel.id) !== String(BUMP_CHANNEL_ID)) {
        return; // Not in the specified bump channel, ignore
      }
      
      const content = (message.content?.toLowerCase() || '');
      const embedContent = message.embeds?.length > 0 
        ? (message.embeds[0].description?.toLowerCase() || message.embeds[0].title?.toLowerCase() || '')
        : '';
      const allContent = content + ' ' + embedContent;
      
      // Disboard sends messages like "Bump done! :thumbsup:" or similar when a bump is successful
      // Also check for variations like "bumped", "bump done", etc.
      const isBumpSuccess = allContent.includes('bump') && (
        allContent.includes('done') || 
        allContent.includes('success') || 
        allContent.includes('complete') ||
        allContent.includes('bumped') ||
        allContent.includes('thank')
      );
      
      if (isBumpSuccess) {
        // Try to find who bumped by checking message mentions or interaction
        let bumperId = null;
        
        // First priority: Check the interaction property (most reliable for slash commands)
        if (message.interaction) {
          bumperId = message.interaction.user.id;
        }
        // Second priority: Check if message mentions a user
        else if (message.mentions.users.size > 0) {
          bumperId = message.mentions.users.first().id;
        }
        // Fallback: check recent messages for /bump command usage
        // This is less reliable but better than nothing
        else {
          try {
            const recentMessages = await message.channel.messages.fetch({ limit: 10 });
            for (const [id, msg] of recentMessages) {
              if (msg.content?.toLowerCase().includes('/bump') && !msg.author.bot) {
                bumperId = msg.author.id;
                break;
              }
            }
          } catch (e) {
            console.warn('Failed to fetch recent messages for bump tracking', e);
          }
        }
        
        if (bumperId) {
          // Initialize if doesn't exist
          if (!db.bumpLeaderboard) db.bumpLeaderboard = {};
          if (!db.bumpLeaderboard[bumperId]) {
            db.bumpLeaderboard[bumperId] = { count: 0, lastBump: null };
          }
          db.bumpLeaderboard[bumperId].count++;
          db.bumpLeaderboard[bumperId].lastBump = Date.now();
          saveDB();
          console.log(`Tracked bump for user ${bumperId}, total bumps: ${db.bumpLeaderboard[bumperId].count}`);
          
          // React with ⏱️ emoji to indicate bump was tracked
          try {
            await message.react('⏱️');
          } catch (e) {
            console.warn('Failed to react to bump message', e);
          }
        } else {
          console.warn('Could not determine who bumped the server from Disboard message');
        }
      }
    }
    
    if (message.author?.bot) return;

    const keywordAutomations = normalizeKeywordAutomations(db.keywordAutomations);
    if (keywordAutomations.length > 0) {
      for (const automation of keywordAutomations) {
        if (messageContainsTrigger(message.content || '', automation.keyword)) {
          await message.channel.send({ content: automation.response.substring(0, 2000) }).catch(() => {});
          break;
        }
      }
    }

    // find ticket by channel id
    const ticketEntry = Object.entries(db.tickets).find(([code, t]) => t.ticketChannelId === message.channel.id);
    if (ticketEntry) {
      const [code, ticket] = ticketEntry;
      const attachments = message.attachments && message.attachments.size ? Array.from(message.attachments.values()).map(a => a.url) : [];

      if (message.author.id === ticket.studentId) {
        ticket.messages.push({ who: 'Student', at: Date.now(), text: message.content || '', attachments });
        saveDB();

        if (!ticket.approved) {
          if (!ticket.awaitingApproval) {
            ticket.awaitingApproval = true;
            saveDB();

            const row = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`approve|${code}`).setLabel('Approve').setStyle(ButtonStyle.Success),
              new ButtonBuilder().setCustomId(`deny|${code}`).setLabel('Deny').setStyle(ButtonStyle.Danger)
            );

            const content = `Please do not type anything else until staff approves your message, as the tutors will only be able to see your first message.`;
            await message.channel.send({ content, components: [row] }).catch(() => {});
            // React ✅ so the student knows the message was received
            message.react('✅').catch(() => {});
            return;
          }

          // Already awaiting approval, echo follow-ups without pinging staff
          try {
            let echo = `Please do not type anything else, staff are reviewing your message.\n\n`;
            echo += message.content && message.content.trim().length ? `> ${message.content}` : '> (no text)';
            if (attachments.length) echo += `\n\nAttachment(s): ${attachments.join(' ')}`;
            await message.channel.send({ content: echo }).catch(() => {});
            message.react('✅').catch(() => {});
          } catch (e) {
            message.react('❌').catch(() => {});
            console.warn('failed to echo student follow-up', e);
            try { notifyStaffError(e, 'messageCreate echo follow-up', message); } catch (err) {}
          }
        } else {
          // approved flow forwards to tutors thread (or directly visible to selected tutor)
          let forwarded = false;
          if (ticket.selectedTutorId) {
            // If a tutor was specifically selected, they will be given access to the ticket channel
            // and no cross-thread forwarding is required — treat as forwarded for reaction purposes.
            forwarded = true;
          } else if (ticket.tutorThreadId) {
            try {
              const thread = await message.guild.channels.fetch(ticket.tutorThreadId).catch(() => null);
              if (thread && thread.isThread()) {
                let content = `Student ${code} says: ${message.content || ''}`;
                if (attachments.length) content += `\nAttachment(s): ${attachments.join(' ')}`;
                await thread.send({ content });
                forwarded = true;
              }
            } catch (e) {
              console.warn('forward fail', e);
              try { notifyStaffError(e, 'messageCreate forward to tutors thread', message); } catch (err) {}
            }
          }
          message.react(forwarded ? '✅' : '❌').catch(() => {});
        }
      } else {
        // tutor, staff, or other wrote in ticket
        const authorId = String(message.author.id);
        // If this author is the selected tutor (and not staff), record as a tutor message
        if (ticket.selectedTutorId && authorId === String(ticket.selectedTutorId) && !isStaff(message.member)) {
          ticket.tutorMap = ticket.tutorMap || {};
          ticket.tutorCount = ticket.tutorCount || 0;
          if (!ticket.tutorMap[authorId]) {
            ticket.tutorCount += 1;
            ticket.tutorMap[authorId] = ticket.tutorCount;
          }
          const tutorLabel = `Tutor ${ticket.tutorMap[authorId]}`;
          ticket.messages.push({ who: tutorLabel, tutorId: authorId, at: Date.now(), text: message.content || '', attachments });
          saveDB();
        } else {
          ticket.messages.push({ who: `Staff ${message.author.id}`, at: Date.now(), text: message.content || '', attachments });
          saveDB();
        }
      }
      return;
    }

    // Tutors feed thread — = prefix bridging
    if (message.channel?.isThread && typeof message.channel.isThread === 'function' && message.channel.isThread()) {
      const threadChannel = await message.channel.fetch(true).catch(() => null);
      if (threadChannel && threadChannel.parentId === TUTORS_FEED_CHANNEL_ID) {
        // Only handle non-bot messages in ticket threads
        if (!message.author.bot) {
          const threadId = message.channel.id;
          const ticketEntry = Object.entries(db.tickets).find(([, t]) => t.tutorThreadId === threadId);
          if (ticketEntry) {
            const [code, ticket] = ticketEntry;

            // Always clear any previous error message when the tutor sends a new message
            if (threadErrorMessages.has(threadId)) {
              const prevErr = threadErrorMessages.get(threadId);
              threadErrorMessages.delete(threadId);
              prevErr.delete().catch(() => {});
            }

            const msgContent = message.content || '';
            if (!msgContent.startsWith('=')) {
              // Normal message (no = prefix) — forward to student
              const text = msgContent;
              const files = [...message.attachments.values()].map(a => a.url);
              // Skip forwarding if there is nothing to send (no text and no attachments)
              if (!text && !files.length) return;
              let forwarded = false;
              try {
                const guild = message.guild;
                const ticketChannel = await guild.channels.fetch(ticket.ticketChannelId).catch(() => null);
                if (ticketChannel) {
                  const userIdStr = String(message.author.id);
                  ticket.tutorMap = ticket.tutorMap || {};
                  ticket.tutorCount = ticket.tutorCount || 0;
                  if (!ticket.tutorMap[userIdStr]) {
                    ticket.tutorCount += 1;
                    ticket.tutorMap[userIdStr] = ticket.tutorCount;
                    saveDB();
                  }
                  const tutorLabel = `Tutor ${ticket.tutorMap[userIdStr]}`;
                  const forwardContent = text ? `Reply from ${tutorLabel}: ${text}` : `Reply from ${tutorLabel}:`;
                  await ticketChannel.send({ content: forwardContent, ...(files.length ? { files } : {}) });
                  ticket.messages = ticket.messages || [];
                  ticket.messages.push({ who: tutorLabel, tutorId: userIdStr, at: Date.now(), text });
                  saveDB();
                  forwarded = true;
                }
              } catch (e) {
                console.warn('Failed to forward tutor message to student', e);
                try { notifyStaffError(e, 'messageCreate bridge forward to student', message); } catch (err) {}
              }
              message.react(forwarded ? '✅' : '❌').catch(() => {});
            } else {
              // = prefix — internal note, post a brief auto-deleting acknowledgment
              try {
                const noteMsg = await message.channel.send(
                  `🔒 Internal note — this message was **not** sent to the student.`
                ).catch(() => null);
                if (noteMsg) {
                  threadErrorMessages.set(threadId, noteMsg);
                  setTimeout(() => {
                    if (threadErrorMessages.get(threadId) === noteMsg) {
                      threadErrorMessages.delete(threadId);
                      noteMsg.delete().catch(() => {});
                    }
                  }, INTERNAL_NOTE_ACK_TIMEOUT_MS);
                }
              } catch (e) {
                console.warn('Failed to post internal-note acknowledgment in tutor thread', e);
              }
            }
          }
        }
      }
    }

  } catch (e) {
    console.warn('messageCreate handler error', e);
    try { await notifyStaffError(e, 'messageCreate handler', message); } catch (err) { console.warn('notifyStaffError failed', err); }
  }
});

// Review reminder worker
setInterval(async () => {
  try {
    const now = Date.now();
    for (const [studentId, asg] of Object.entries(db.studentAssignments || {})) {
      if (!asg || !asg.reviewScheduledAt) continue;
      if (asg.reviewSentAt) continue; // already sent
      if (now >= asg.reviewScheduledAt) {
        // send DM to student asking for review, mark as sent time
        try {
          const student = await client.users.fetch(studentId).catch(() => null);
          if (student) {
            // simple message with button to submit review (modal via interaction required)
            const rows = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId(`review_start|${studentId}|${asg.tutorId}`).setLabel('Leave a review').setStyle(ButtonStyle.Primary)
            );
            await student.send({ content: `Hi, it's been a while since your class. Would you like to leave a review for your tutor?`, components: [rows] }).catch(() => {});
            // flag that we've sent reminder
            db.studentAssignments[studentId].reviewSentAt = now;
            saveDB();
            // notify staff
            try {
              const staffCh = await client.channels.fetch(STAFF_CHAT_ID).catch(() => null);
              if (staffCh) await staffCh.send({ content: `Review reminder sent to <@${studentId}> for tutor <@${asg.tutorId}>` }).catch(() => {});
            } catch (e) {}
          }
        } catch (e) { console.warn('failed to send review reminder', e); try { notifyStaffError(e, 'review reminder worker'); } catch (err) {} }
      }
    }
  } catch (e) { console.warn('review reminder worker error', e); }
}, 60 * 1000); // runs every minute

// Ticket inactivity worker: auto-close tickets where the student has sent no message within 24 hours
setInterval(async () => {
  try {
    const now = Date.now();
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    for (const [code, ticket] of Object.entries(db.tickets || {})) {
      try {
        if (!ticket || !ticket.createdAt) continue;
        if (ticket.inactivityClosedAt || ticket.inactivityNotified) continue;
        // ticket.messages uses who === 'Student' (hardcoded string) for the regular ticket system.
        // The modmail system uses who = "User " followed by user tag or ID — intentionally different.
        const hasStudentMessage = (ticket.messages || []).some(m => m.who === 'Student');
        if (hasStudentMessage) continue;
        // Act only after 24 hours have elapsed
        if (now - ticket.createdAt < TWENTY_FOUR_HOURS) continue;
        // Mark as handled before any outbound action so restarts do not re-send the DM.
        ticket.inactivityClosedAt = now;
        ticket.inactivityNotified = true;
        saveDB();
        await appwriteClient.syncDB(db).catch(err => {
          console.warn(`ticket inactivity: failed to persist handled flag for ${code}`, err);
        });
        // DM the student
        try {
          const student = await client.users.fetch(ticket.studentId).catch(() => null);
          if (student) {
            await student.send(
              `Your tutor enquiry ticket (code: **${code}**, subject: **${ticket.subject || 'N/A'}**) has been automatically deleted because no message was received from you within 24 hours of opening it.\n\nIf you still need help, you are welcome to create a new ticket.`
            ).catch(() => {});
          }
        } catch (e) { console.warn(`ticket inactivity: could not DM student for ${code}`, e); }
        // Delete the channel
        try {
          const ch = await client.channels.fetch(ticket.ticketChannelId).catch(() => null);
          if (ch) {
            await ch.send('This ticket has been automatically closed due to inactivity (no message received within 24 hours).').catch(() => {});
            await ch.delete('Auto-closed: no student message within 24 hours').catch(async (err) => {
              console.warn(`ticket inactivity: channel delete failed for ${code}`, err);
              try { await ch.permissionOverwrites.edit(ticket.studentId, { ViewChannel: false, SendMessages: false }).catch(() => {}); } catch (ee) {}
            });
          }
        } catch (e) { console.warn(`ticket inactivity: channel cleanup failed for ${code}`, e); }
        // Remove from db
        delete db.tickets[code];
        saveDB();
      } catch (e) {
        console.warn(`ticket inactivity worker: error for ticket ${code}`, e);
        try { notifyStaffError(e, `ticket inactivity worker ${code}`); } catch (err) {}
      }
    }
  } catch (e) { console.warn('ticket inactivity worker error', e); }
}, 60 * 1000); // runs every minute

client.login(BOT_TOKEN).catch(err => {
  console.error('login failed', err);
  try { notifyStaffError(err, 'client.login'); } catch (e) { console.warn('notify failed login', e); }
});
