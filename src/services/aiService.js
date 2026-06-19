import axios from 'axios';
import { PermissionsBitField } from 'discord.js';
import { logger } from '../utils/logger.js';
import { pgDb } from '../utils/database.js';

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

// Helper to make OpenRouter API calls
const callOpenRouter = async (messages) => {
  const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
    // You can change this to any free model on OpenRouter!
    // Check https://openrouter.ai/models?max_price=0 for free models
    model: 'google/gemini-2.0-flash-exp:free', 
    messages: messages
  }, {
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://github.com/VRSDevelopment/DepressedGamers',
      'X-Title': 'DepressedGamers Bot',
      'Content-Type': 'application/json'
    }
  });

  if (response.data && response.data.choices && response.data.choices.length > 0) {
    return response.data.choices[0].message.content;
  }
  throw new Error('Invalid response from OpenRouter');
};

export const generateAIResponse = async (message, userMessage, systemPrompt) => {
  const guildId = message.guild.id;

  if (!process.env.OPENROUTER_API_KEY) {
     return "Sorry, the AI feature is currently unavailable (OPENROUTER_API_KEY missing).";
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

    const messages = [];
    messages.push({ role: 'system', content: promptInstructions });
    
    // Convert history into contents array for OpenRouter
    for (const msg of history) {
      messages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content
      });
    }
    
    // Add current user message
    messages.push({ role: 'user', content: userMessage });

    let reply = await callOpenRouter(messages);

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
              messages.push({ role: 'assistant', content: reply });
              messages.push({ role: 'user', content: `SYSTEM LOG: Successfully disconnected ${targetMember.user.username} from their voice channel. Please confirm to the user.` });
              
              reply = await callOpenRouter(messages);
            } catch (kickError) {
              logger.error('Failed to kick user from voice:', kickError);
              messages.push({ role: 'assistant', content: reply });
              messages.push({ role: 'user', content: `SYSTEM LOG: I failed to disconnect the user due to a permission error: ${kickError.message}. The bot probably lacks 'Move Members' permission. Please apologize and tell the user.` });
              
              reply = await callOpenRouter(messages);
            }
          } else {
            // Ask AI to tell the user the person wasn't found
            messages.push({ role: 'assistant', content: reply });
            messages.push({ role: 'user', content: `SYSTEM LOG: Could not find any user matching "${targetUsername}" in any voice channel. Please tell the user.` });
            
            reply = await callOpenRouter(messages);
          }
        }
      }
    }

    // Update history
    history.push({ role: 'user', content: userMessage });
    history.push({ role: 'assistant', content: reply });

    // Keep history from getting too long
    if (history.length > MAX_HISTORY_LENGTH * 2) {
      // Remove oldest pair (user + model)
      history.splice(0, 2);
    }

    return reply;
    
  } catch (error) {
    logger.error('Error generating AI response via OpenRouter:', error);
    
    // Check for rate limit
    if (error.response && error.response.status === 429) {
      return "I'm currently receiving too many requests. Please wait a moment and try again.";
    }
    
    return "I'm sorry, I encountered an error while trying to generate a response.";
  }
};
