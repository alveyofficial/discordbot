import OpenAI from 'openai';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} from 'discord.js';
import { isWebsiteConfigured, loadTutorContext } from './appwrite/appwrite-website-reader.js';

const HISTORY_LIMIT = 10;
const CONTEXT_REFRESH_MS = 5 * 60 * 1000;
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const conversationHistory = new Map();
const pendingTicketConfirmations = new Map();

function getHistory(userId) {
  if (!conversationHistory.has(userId)) conversationHistory.set(userId, []);
  return conversationHistory.get(userId);
}

function appendHistory(userId, role, content) {
  const history = getHistory(userId);
  history.push({ role, content: String(content || '').slice(0, 4000) });
  while (history.length > HISTORY_LIMIT) history.shift();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function formatTutorName(tutorId, profile = {}) {
  return profile.displayName || profile.name || profile.username || profile.tag || `Tutor ${String(tutorId).slice(-4)}`;
}

function extractAdPrice(ad = {}) {
  const details = ad.fullDetails || {};
  const parts = [];
  if (details.price) parts.push(`group $${details.price}`);
  if (details.price1on1) parts.push(`1-on-1 $${details.price1on1}`);
  if (details.classDuration) parts.push(details.classDuration);
  if (details.timezone) parts.push(`timezone ${details.timezone}`);
  return parts.join(', ');
}

function buildContextSnapshot(rawContext, fallbackDb) {
  const context = rawContext || {
    subjects: fallbackDb.subjects || [],
    subjectLevels: fallbackDb.subjectLevels || {},
    subjectTutors: fallbackDb.subjectTutors || {},
    tutorProfiles: fallbackDb.tutorProfiles || {},
    ads: Object.entries(fallbackDb.createAds || {}).map(([id, ad]) => ({ id, ...ad, fullDetails: ad.fullDetails || null, tutorId: ad.tutorId || null }))
  };

  const subjects = safeArray(context.subjects).map(subject => {
    if (typeof subject === 'string') return subject;
    return subject?.name || subject?.title || subject?.subject || '';
  }).filter(Boolean);
  const subjectLevels = context.subjectLevels || {};
  const subjectTutors = context.subjectTutors || {};
  const tutorProfiles = context.tutorProfiles || {};
  const ads = safeArray(context.ads);

  const subjectsByLevel = new Map();
  for (const subject of subjects) {
    const level = subjectLevels[subject] || 'other';
    if (!subjectsByLevel.has(level)) subjectsByLevel.set(level, []);
    subjectsByLevel.get(level).push(subject);
  }

  const lines = [];
  lines.push('Available subjects by level:');
  for (const [level, names] of [...subjectsByLevel.entries()].sort()) {
    lines.push(`- ${level}: ${names.slice(0, 60).join(', ')}`);
  }

  lines.push('');
  lines.push('Tutors and pricing:');
  const tutorSubjectMap = new Map();
  for (const [subject, tutorIds] of Object.entries(subjectTutors)) {
    for (const tutorId of safeArray(tutorIds)) {
      const id = String(tutorId);
      if (!tutorSubjectMap.has(id)) tutorSubjectMap.set(id, []);
      tutorSubjectMap.get(id).push(subject);
    }
  }
  for (const [tutorId, tutorSubjects] of [...tutorSubjectMap.entries()].slice(0, 80)) {
    const profile = tutorProfiles[tutorId] || {};
    const rating = profile.rating?.avg ? `, rating ${profile.rating.avg}/5 (${profile.rating.count || 0})` : '';
    const tutorAds = ads.filter(ad => String(ad.tutorId || ad.createdBy || '') === tutorId);
    const pricing = tutorAds.map(extractAdPrice).filter(Boolean).slice(0, 3).join('; ');
    lines.push(`- ${formatTutorName(tutorId, profile)} (${tutorId}): ${tutorSubjects.slice(0, 12).join(', ')}${rating}${pricing ? `. Pricing: ${pricing}` : ''}`);
  }

  if (!tutorSubjectMap.size && ads.length) {
    for (const ad of ads.slice(0, 60)) {
      const subject = ad.embed?.title || ad.title || ad.subject || 'Tutor ad';
      const pricing = extractAdPrice(ad);
      lines.push(`- ${subject}${ad.tutorId ? ` tutorId ${ad.tutorId}` : ''}${pricing ? `. Pricing: ${pricing}` : ''}`);
    }
  }

  return {
    text: lines.join('\n').slice(0, 18000),
    tutorCount: tutorSubjectMap.size || new Set(ads.map(ad => ad.tutorId).filter(Boolean)).size,
    subjectCount: subjects.length
  };
}

function buildSystemPrompt(contextSnapshot) {
  return `You are Alvey Assistant, the professional and friendly AI assistant for the Alvey tutoring Discord server.
Reply primarily in English. If the user clearly writes in another language, adapt politely to that language while keeping names, subjects, and booking details clear.

Use only the tutor, subject, and pricing context below. If data is missing or uncertain, say so and offer to connect the user with staff.

You can answer tutor questions, explain subjects/pricing, help users choose a tutor, and guide them toward booking.
When the user is ready to book or asks to open/create/start an enquiry ticket, include a compact JSON object on its own line:
{"intent":"create_ticket","subject":"subject name","tutorId":"optional tutor id or empty string","summary":"brief booking summary"}
Do not include that JSON unless the user has a concrete booking/enquiry intent.

Tutor context:
${contextSnapshot || '(No live tutor context is available. Ask for the subject and offer to connect them with staff.)'}`;
}

function extractIntent(reply) {
  const objectRegex = /\{[\s\S]*?"intent"\s*:\s*"create_ticket"[\s\S]*?\}/;
  const match = reply.match(objectRegex);
  if (!match) return { text: reply.trim(), intent: null };
  try {
    const intent = JSON.parse(match[0]);
    const text = reply.replace(match[0], '').trim();
    return { text, intent };
  } catch {
    return { text: reply.trim(), intent: null };
  }
}

function getTargetChannelId(db) {
  return db.aiChannelId || process.env.AI_CHANNEL_ID || null;
}

export default function initAIAssistant({ client, db, saveDB, createEnquiryTicket, notifyError = null } = {}) {
  if (!client || !db || !saveDB || !createEnquiryTicket) throw new Error('initAIAssistant missing args');

  if (!process.env.OPENAI_API_KEY) {
    console.warn('[Alvey] OPENAI_API_KEY missing; AI assistant disabled.');
    return;
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  let cachedContext = { text: '', tutorCount: 0, subjectCount: 0 };

  async function refreshContext() {
    try {
      const raw = isWebsiteConfigured() ? await loadTutorContext() : null;
      cachedContext = buildContextSnapshot(raw, db);
      const source = raw ? 'WebsiteDB' : 'BotDB fallback';
      console.log(`[Alvey] Context refreshed (${source}) - ${cachedContext.tutorCount} tutors, ${cachedContext.subjectCount} subjects.`);
    } catch (err) {
      console.warn('[Alvey] Context refresh failed:', err.message);
      cachedContext = buildContextSnapshot(null, db);
    }
  }

  refreshContext();
  setInterval(refreshContext, CONTEXT_REFRESH_MS).unref?.();

  client.on('messageCreate', async (message) => {
    try {
      if (!message.guild || message.author?.bot) return;
      const targetChannelId = getTargetChannelId(db);
      if (!targetChannelId || String(message.channel.id) !== String(targetChannelId)) return;
      if (!message.mentions.has(client.user)) return;

      const userText = String(message.content || '')
        .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
        .trim();
      if (!userText) return;

      await message.channel.sendTyping().catch(() => {});
      appendHistory(message.author.id, 'user', userText);

      const completion = await openai.chat.completions.create({
        model: MODEL,
        messages: [
          { role: 'system', content: buildSystemPrompt(cachedContext.text) },
          ...getHistory(message.author.id)
        ],
        temperature: 0.4
      });

      const rawReply = completion.choices?.[0]?.message?.content || 'I can help with tutor enquiries. What subject are you looking for?';
      const { text, intent } = extractIntent(rawReply);
      const cleanText = text || 'I can help create an enquiry ticket for that.';
      appendHistory(message.author.id, 'assistant', cleanText);

      if (!intent) {
        await message.reply({ content: cleanText.slice(0, 2000), allowedMentions: { repliedUser: false } }).catch(() => {});
        return;
      }

      const subject = String(intent.subject || '').trim() || 'Tutoring enquiry';
      const summary = String(intent.summary || `Tutoring enquiry for ${subject}`).trim();
      const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      pendingTicketConfirmations.set(nonce, {
        userId: message.author.id,
        subject,
        tutorId: intent.tutorId ? String(intent.tutorId) : null,
        summary,
        createdAt: Date.now()
      });

      const embed = new EmbedBuilder()
        .setTitle('Confirm enquiry ticket')
        .setDescription(summary.slice(0, 3500))
        .addFields(
          { name: 'Subject', value: subject.slice(0, 1024) },
          { name: 'Next step', value: 'Confirm to create a private in-server enquiry ticket with staff.' }
        )
        .setTimestamp();
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`ai_confirm_ticket|${message.author.id}|${nonce}`)
          .setLabel('Create enquiry ticket')
          .setStyle(ButtonStyle.Success)
      );

      await message.reply({ content: cleanText.slice(0, 1800), embeds: [embed], components: [row], allowedMentions: { repliedUser: false } }).catch(() => {});
    } catch (err) {
      console.warn('[Alvey] messageCreate failed:', err);
      if (notifyError) await notifyError(err, { module: 'ai-assistant.messageCreate', message }).catch(() => {});
      await message.reply({ content: 'Sorry, I could not process that right now. Please try again shortly.', allowedMentions: { repliedUser: false } }).catch(() => {});
    }
  });

  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.isButton() || !interaction.customId.startsWith('ai_confirm_ticket|')) return;
      const [, userId, nonce] = interaction.customId.split('|');
      if (String(interaction.user.id) !== String(userId)) {
        return interaction.reply({ content: 'This confirmation button belongs to the user who asked Alvey.', ephemeral: true }).catch(() => {});
      }
      const pending = pendingTicketConfirmations.get(nonce);
      if (!pending) {
        return interaction.reply({ content: 'This booking confirmation has expired. Please mention Alvey again to create a fresh one.', ephemeral: true }).catch(() => {});
      }
      pendingTicketConfirmations.delete(nonce);
      await createEnquiryTicket(interaction, {
        subject: pending.subject,
        selectedTutorId: pending.tutorId,
        source: 'alvey',
        creatingMessage: `Creating ticket for ${pending.subject}...`,
        successVerb: 'See'
      });
      appendHistory(interaction.user.id, 'assistant', `Ticket created for ${pending.subject}`);
    } catch (err) {
      console.warn('[Alvey] interactionCreate failed:', err);
      if (notifyError) await notifyError(err, { module: 'ai-assistant.interactionCreate', interaction }).catch(() => {});
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Could not create the ticket right now. Please try again shortly.', ephemeral: true }).catch(() => {});
      }
    }
  });

  console.log('Alvey AI assistant initialized');
}
