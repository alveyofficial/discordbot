# Alvey Discord Bot
 
With AI Integration!!

---
## Tech Stack

- **[discord.js](https://discord.js.org/) v14** — Core Discord API library
- **[Express](https://expressjs.com/) v5** — Web server
- **[dotenv](https://github.com/motdotla/dotenv)** — Environment variable loading
- **[Appwrite](https://appwrite.io/)** — Optional cloud data persistence (falls back to local `data.json`)

---

## Requirements

- Node.js 18 or later (Node.js 20 LTS recommended)
- A Discord application & bot token ([Discord Developer Portal](https://discord.com/developers/applications))
- The bot must be invited to the server with the required intents and slash-command permissions

---



## Installation

```bash
# 1. Clone the repository
git clone <repository-url>
cd 

# 2. Install dependencies
npm install

# 3. Create a .env file (see Configuration section below)

# 4. Start the bot
node index.js
```

---

## Configuration

Create a `.env` file (local development) or set the same values in your hosting provider's environment panel. Required variables are marked with ✱.

| Variable | Required | Description |
|---|---|---|
| `BOT_TOKEN` | ✱ | Discord bot token |
| `GUILD_ID` | ✱ | Discord server (guild) ID |
| `STAFF_ROLE_ID` | ✱ | Staff role ID(s) |
| `FIND_A_TUTOR_CHANNEL_ID` | ✱ | Channel where the sticky message lives |
| `TUTORS_FEED_CHANNEL_ID` | ✱ | Channel for tutor feed announcements |
| `STAFF_CHAT_ID` | | Channel for staff notifications and bot error reports |
| `TICKET_CATEGORY_ID` | | Category for enquiry ticket channels |
| `TRANSCRIPTS_CHANNEL_ID` | | Channel where ticket transcripts are posted |
| `TUTOR_CHAT_CHANNEL_ID` | | Channel for internal tutor discussions |
| `TUTOR_POLICIES_CHANNEL_ID` | | Channel for tutor policy documents |
| `MODMAIL_CATEGORY_ID` | | Default category for modmail channels |
| `MODMAIL_TRANSCRIPTS_CHANNEL_ID` | | Channel for modmail transcripts |
| `BUMP_CHANNEL_ID` | | Channel to restrict bump tracking (all channels if omitted) |
| `DISCORD_CLIENT_ID` | | Discord OAuth2 client ID (for web dashboard login) |
| `DISCORD_CLIENT_SECRET` | | Discord OAuth2 client secret |
| `DISCORD_REDIRECT_URI` | | OAuth2 redirect URI (auto-detected if omitted) |
| `SYNC_SECRET` | | Shared secret for external webhook sync |
| `SYNC_WEBHOOK_URL` | | External webhook URL to sync data to |

---

## Data Storage

All persistent data is stored locally in **`data.json`** (or in Appwrite if configured), including:

- Subject and subject-level mappings
- Tutor profiles, assigned subjects, and notes
- Student-tutor assignments
- Ticket records and transcript metadata
- Pending and approved reviews
- Bump leaderboard counts
- Modmail ticket records and per-category counters
- Bot configuration (embed colour, initial message, review reminder delay)


## Features

### 🎓 Enquiry & Ticket System
- Students create enquiry tickets for a chosen subject via `/enquire`
- Tickets are opened inside a dedicated category with a customisable initial message
- Staff close tickets with `/close <code>`, specifying a reason and assigning a tutor
- Closed tickets generate a transcript posted to a configurable transcripts channel
- A review reminder is automatically sent to the student after a configurable delay
- Tickets with no student message within 24 hours are automatically closed

### 📬 Modmail System
- Students initiate modmail sessions by sending a DM to the bot
- Supports four ticket categories selectable via drop-down:
  - **A** — Tutor Application
  - **C** — Complaints & Suggestions
  - **S** — Customer Service
  - **P** — Payment
- Staff can remap those categories with `/modmailmap` using a Discord category picker
- Each category maintains its own independent ticket counter
- 120-second per-user cooldown per category prevents spam
- Staff messages are forwarded into the ticket channel; student messages are forwarded back to the user's DM
- Reaction feedback (✅ / ❌) confirms whether forwarding succeeded
- Closing a ticket triggers a modal to collect a closure reason and posts a full transcript

### ⭐ Review System
- Students receive a review prompt after a ticket closes (configurable delay via `/reviewreminder`)
- Reviews are submitted via a modal (rating 1–5 stars + written feedback)
- Submitted reviews enter a pending queue for staff approval
- Staff approve, deny, or redact reviews using buttons in the staff chat channel
- Approved reviews are stored on the tutor's profile with a running average rating

### 👩‍🏫 Tutor Management
- Add or remove tutors with `/tutor add|remove <user>`
- Assign subjects to tutors and list tutor subjects with `/tutor add|remove|list`
- View a tutor's full profile (subjects, students, reviews, notes) with `/tutor info`
- Add internal notes to a tutor's record with `/tutor notes`
- Edit tutor profile fields (phone number, date of birth) with `/tutor edit`

### 📚 Subject Management
- Add, remove, and list subjects with `/subject add|remove|list`
- Link subjects to academic levels (IGCSE, A Level, Below IGCSE, University, Language, Test Prep, Other)
- Filter subject listings by level and tutor-assignment status
- Seed a standard set of IGCSE / AS / A Level subjects with `/seedsubjects`

### 🧑‍🎓 Student Assignment
- Assign students to a tutor with `/student add` using Discord user pickers
- Remove student assignments with `/student remove`
- List student assignments with `/student list`, with optional tutor and subject filters
- Student assignment data is stored per tutor and visible in their profile

### 📌 Sticky Messages
- Staff can create or update a sticky welcome/info message in find-a-tutor via `/sticky`
- The sticky is reposted when staff run `/sticky` again — it does not auto-repost on every message

### 🏆 Bump Leaderboard
- Automatically tracks DISBOARD bump interactions
- Displays a ranked leaderboard via `/bumpleaderboard`
- Optionally restricted to a configured bump channel

### 🤖 Alvey AI Assistant
- Responds to mentions in a configured public channel
- Channel is set with `/aichannel set`

### 🛠️ Admin & Utility Commands
- `/sticky` — Create or edit the sticky message in find-a-tutor (modal-based)
- `/embedcolor <hex>` — Set the default embed accent colour for the bot
- `/editinit` — Edit the initial message shown when a ticket is opened (modal-based)
- `/reviewreminder <seconds>` — Configure the delay before a review prompt is sent
- `/keyword set|list|remove` — Manage server-wide trigger keyword auto-responses
- `/modmailmap` — Map a modmail purpose to a Discord category channel
- `/seedsubjects` — Seed the standard IGCSE / AS / A Level subject list (idempotent)
- `/staffhelp` — Display the full list of staff-only commands
- `/help` — Display user-facing commands

### 🌐 Web Dashboard
- Express-based web server running on port **9904**
- Authenticate via Discord OAuth2
- Rate-limited to 10 requests per minute per IP

---