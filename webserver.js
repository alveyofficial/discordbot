/**
 * webserver.js
 * Web server module for authentication and API endpoints
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Authentication tokens: token -> { expiresAt, createdAt }
const authTokens = new Map();

// Generate authentication token (cryptographically secure random token)
export function generateAuthToken() {
  // Generate a secure random token
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + (2 * 60 * 1000); // 2 minutes
  
  // Hash the token for secure storage (using SHA-256)
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  
  // Store the hash with expiration
  authTokens.set(tokenHash, {
    expiresAt,
    createdAt: Date.now()
  });
  
  // Cleanup expired tokens after expiration
  setTimeout(() => {
    authTokens.delete(tokenHash);
  }, 2 * 60 * 1000);
  
  // Return the original token (not the hash) for the user
  return token;
}

// Verify authentication token
export function verifyAuthToken(token) {
  if (!token) return false;
  
  // Hash the provided token to compare with stored hash
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  
  const tokenData = authTokens.get(tokenHash);
  if (!tokenData) return false;
  
  if (Date.now() > tokenData.expiresAt) {
    authTokens.delete(tokenHash);
    return false;
  }
  
  return true;
}

// Cleanup expired tokens
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of authTokens.entries()) {
    if (now > data.expiresAt) {
      authTokens.delete(token);
    }
  }
}, 60000); // Check every minute

// Simple rate limiter for auth endpoints: tracks request counts per IP
const rateLimitMap = new Map(); // ip -> { count, resetAt }
function checkRateLimit(ip, maxRequests = 10, windowMs = 60000) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
    return false; // not limited
  }
  entry.count += 1;
  if (entry.count > maxRequests) return true; // limited
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of rateLimitMap.entries()) {
    if (now > data.resetAt) rateLimitMap.delete(ip);
  }
}, 60000);

// Setup web server routes
export function setupWebServer(app) {
  // Parse JSON bodies
  app.use(express.json());
  app.use(express.static(path.join(__dirname)));
  
  // Serve CSS file
  app.get('/styles.css', (req, res) => {
    res.sendFile(path.join(__dirname, 'styles.css'));
  });
  
  // Serve webapp HTML
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'webapp.html'));
  });
  
  // Serve recording page
  app.get('/recording/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'webapp.html'));
  });
  
  // API: Authenticate
  app.post('/api/auth', (req, res) => {
    const { token } = req.body;
    
    if (!token) {
      return res.status(400).json({ error: 'Token required' });
    }
    
    if (verifyAuthToken(token)) {
      res.json({ success: true });
    } else {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  });
  
  // API: Get Discord OAuth2 authorization URL
  app.get('/api/discord-auth-url', (req, res) => {
    const clientId = process.env.DISCORD_CLIENT_ID;
    const redirectUri = process.env.DISCORD_REDIRECT_URI || `${req.protocol}://${req.get('host')}/discordAuthCallback`;
    if (!clientId) {
      return res.status(500).json({ error: 'Discord client ID not configured' });
    }
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'identify email'
    });
    const url = `https://discord.com/api/oauth2/authorize?${params.toString()}`;
    res.json({ url });
  });

  // Discord OAuth2 callback
  app.get('/discordAuthCallback', async (req, res) => {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    if (checkRateLimit(ip, 10, 60000)) {
      return res.status(429).send('Too many requests. Please try again later.');
    }
    const { code } = req.query;
    if (!code) {
      return res.status(400).send('Missing authorization code');
    }
    const clientId = process.env.DISCORD_CLIENT_ID;
    const clientSecret = process.env.DISCORD_CLIENT_SECRET;
    const redirectUri = process.env.DISCORD_REDIRECT_URI || `${req.protocol}://${req.get('host')}/discordAuthCallback`;
    if (!clientId || !clientSecret) {
      return res.status(500).send('Discord OAuth2 not configured');
    }
    try {
      // Exchange code for access token
      const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri
        }).toString()
      });
      if (!tokenResponse.ok) {
        const err = await tokenResponse.text();
        console.warn('Discord token exchange failed', err);
        return res.status(502).send('Failed to exchange Discord authorization code');
      }
      const tokenData = await tokenResponse.json();
      // Mint a short-lived auth token for the session
      const sessionToken = generateAuthToken();
      res.redirect(`/?token=${encodeURIComponent(sessionToken)}`);
    } catch (e) {
      console.error('discordAuthCallback error', e);
      res.status(500).send('Internal server error during Discord authentication');
    }
  });

}

