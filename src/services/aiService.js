import { GoogleGenAI } from '@google/genai';
import { PermissionsBitField } from 'discord.js';
import { logger } from '../utils/logger.js';
import { pgDb } from '../utils/database.js';

let aiClient = null;

export const initAIClient = () => {
  if (!process.env.GEMINI_API_KEY) {
    logger.warn('GEMINI_API_KEY is not set in the environment variables. AI features will be disabled.');
    return false;
  }
  
  try {
    // Initialize the new SDK
    aiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    return true;
  } catch (error) {
    logger.error('Failed to initialize Google Gen AI client:', error);
    return false;
  }
};

export const getAIConfig = async (guildId) => {
  try {
    const result = await pgDb.pool.query(
      'SELECT channel_id, enabled, system_prompt FROM ai_configs WHERE guild_id = $1',
      [guildId]
    );
    if (result.rows.length > 0) {
      return result.rows[0];
    }
    return { channel_id: null, enabled: false, system_prompt: null };
  } catch (error) {
    logger.error(`Error fetching AI config for guild ${guildId}:`, error);
    return { channel_id: null, enabled: false, system_prompt: null };
  }
};

export const saveAIConfig = async (guildId, config) => {
  try {
    await pgDb.pool.query(
      `INSERT INTO ai_configs (guild_id, channel_id, enabled, system_prompt)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (guild_id)
       DO UPDATE SET channel_id = EXCLUDED.channel_id, enabled = EXCLUDED.enabled, system_prompt = EXCLUDED.system_prompt`,
      [guildId, config.channel_id, config.enabled, config.system_prompt]
    );
    return true;
  } catch (error) {
    logger.error(`Error saving AI config for guild ${guildId}:`, error);
    return false;
  }
};

// Store recent conversation history per guild to provide context
const conversationHistory = new Map();
const MAX_HISTORY_LENGTH = 10;

export const generateAIResponse = async (message, userMessage, systemPrompt) => {
  const guildId = message.guild.id;

  if (!aiClient) {
    if (!initAIClient()) {
       return "Sorry, the AI feature is currently unavailable (API key missing).";
    }
  }

  try {
    // Initialize history for the guild if it doesn't exist
    if (!conversationHistory.has(guildId)) {
      conversationHistory.set(guildId, []);
    }

    const history = conversationHistory.get(guildId);
    
    // Default system prompt if none is provided
    let promptInstructions = systemPrompt || "You are a helpful, friendly, and concise Discord bot. Respond directly to the user's messages without adding formatting unless it's useful.";
    
    // Add ability instructions
    promptInstructions += "\n\nSPECIAL ABILITY: If the user explicitly asks you to kick someone from a voice channel, output EXACTLY this format and nothing else: [KICK_VOICE: username]. The system will intercept this, perform the action, and return the result to you so you can confirm to the user.";

    const contents = [];
    
    // Convert history into contents array for Gemini
    for (const msg of history) {
      contents.push({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.content }]
      });
    }
    
    // Add current user message
    contents.push({
      role: 'user',
      parts: [{ text: userMessage }]
    });

    let response = await aiClient.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: contents,
        config: {
            systemInstruction: promptInstructions,
        }
    });

    let reply = response.text;

    // Check for interception abilities
    if (reply.includes('[KICK_VOICE:')) {
      const match = reply.match(/\[KICK_VOICE:\s*(.+?)\]/);
      if (match) {
        const targetUsername = match[1].trim();
        
        if (!message.member.permissions.has(PermissionsBitField.Flags.MoveMembers)) {
          reply = "You don't have permission to disconnect members from voice channels.";
        } else {
          // Find member in voice channel
          const voiceChannels = message.guild.channels.cache.filter(c => c.isVoiceBased());
          let targetMember = null;
          for (const [id, channel] of voiceChannels) {
            targetMember = channel.members.find(m => 
              m.user.username.toLowerCase().includes(targetUsername.toLowerCase()) || 
              (m.nickname && m.nickname.toLowerCase().includes(targetUsername.toLowerCase()))
            );
            if (targetMember) break;
          }

          if (targetMember) {
            try {
              await targetMember.voice.disconnect(`Kicked by AI upon request from ${message.author.tag}`);
              
              // Ask AI to generate final response confirming the kick
              contents.push({ role: 'model', parts: [{ text: reply }] });
              contents.push({ role: 'user', parts: [{ text: `SYSTEM LOG: Successfully disconnected ${targetMember.user.username} from their voice channel. Please confirm to the user.` }] });
              
              const followup = await aiClient.models.generateContent({
                  model: 'gemini-2.5-flash',
                  contents: contents,
                  config: { systemInstruction: promptInstructions }
              });
              reply = followup.text;
            } catch (kickError) {
              logger.error('Failed to kick user from voice:', kickError);
              contents.push({ role: 'model', parts: [{ text: reply }] });
              contents.push({ role: 'user', parts: [{ text: `SYSTEM LOG: I failed to disconnect the user due to a permission error: ${kickError.message}. The bot probably lacks 'Move Members' permission. Please apologize and tell the user.` }] });
              
              const followup = await aiClient.models.generateContent({
                  model: 'gemini-2.5-flash',
                  contents: contents,
                  config: { systemInstruction: promptInstructions }
              });
              reply = followup.text;
            }
          } else {
            // Ask AI to tell the user the person wasn't found
            contents.push({ role: 'model', parts: [{ text: reply }] });
            contents.push({ role: 'user', parts: [{ text: `SYSTEM LOG: Could not find any user matching "${targetUsername}" in any voice channel. Please tell the user.` }] });
            
            const followup = await aiClient.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: contents,
                config: { systemInstruction: promptInstructions }
            });
            reply = followup.text;
          }
        }
      }
    }

    // Update history
    history.push({ role: 'user', content: userMessage });
    history.push({ role: 'model', content: reply });

    // Keep history length bounded
    if (history.length > MAX_HISTORY_LENGTH * 2) {
      history.splice(0, history.length - (MAX_HISTORY_LENGTH * 2));
    }

    return reply;
  } catch (error) {
    logger.error('Error generating AI response:', error);
    return "I'm sorry, I encountered an error while trying to generate a response.";
  }
};
