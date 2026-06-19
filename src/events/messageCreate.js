import { Events } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getLevelingConfig, getUserLevelData } from '../services/leveling.js';
import { addXp } from '../services/xpSystem.js';
import { checkRateLimit } from '../utils/rateLimiter.js';
import { parsePrefixCommand } from '../utils/prefixParser.js';
import { supportsPrefixExecution, executePrefixCommand, resolvePrefixAccessKey } from '../utils/messageAdapter.js';
import { resolveCommandAlias, resolveSubcommandAlias } from '../config/commandAliases.js';
import { getPrefixRestriction } from '../config/prefixRestrictions.js';
import { getGuildConfig } from '../services/guildConfig.js';
import { enforceAbuseProtection, formatCooldownDuration } from '../utils/abuseProtection.js';
import { createEmbed } from '../utils/embeds.js';
import { isCommandEnabled } from '../services/commandAccessService.js';
import {
  getCountingGameConfig,
  saveCountingGameConfig,
  isValidCountingMessage,
  recordCorrectCount,
} from '../services/countingGameService.js';
import { getAIConfig, generateAIResponse } from '../services/aiService.js';

const MESSAGE_XP_RATE_LIMIT_ATTEMPTS = 12;
const MESSAGE_XP_RATE_LIMIT_WINDOW_MS = 10000;

export default {
  name: Events.MessageCreate,
  async execute(message, client) {
    try {
      if (message.author.bot || !message.guild) return;

      logger.debug(`Message received from ${message.author.tag}: ${message.content}`);

      const countingProcessed = await handleCountingGame(message, client);
      if (countingProcessed) {
        return;
      }

      const aiProcessed = await handleAIChat(message, client);
      if (aiProcessed) {
        return;
      }

      await handlePrefixCommand(message, client);

      await handleLeveling(message, client);
    } catch (error) {
      logger.error('Error in messageCreate event:', error);
    }
  }
};

async function handlePrefixCommand(message, client) {
  try {
    const guildConfig = await getGuildConfig(client, message.guild.id);
    const prefix = guildConfig?.prefix || client.config.bot.prefix || '!';
    const parsed = parsePrefixCommand(message.content, prefix);
    
    if (!parsed) {
      return; 
    }

    const { commandName, args } = parsed;
    logger.info(`Prefix command detected: ${commandName}, args: ${args.join(', ')}`);

    const resolvedCommandName = resolveCommandAlias(commandName);
    logger.info(`Resolved command name: ${resolvedCommandName}`);
    const command = client.commands.get(resolvedCommandName);

    if (!command) {
      logger.warn(`Command not found: ${resolvedCommandName}`);
      return; 
    }

    const restriction = getPrefixRestriction(command, args, resolveSubcommandAlias);
    if (!supportsPrefixExecution(command) || restriction.blocked) {
      if (restriction.blocked && restriction.reason) {
        const embed = createEmbed({
          title: 'Slash Command Only',
          description: `${restriction.reason}\nUse \`/${resolvedCommandName}\` instead.`,
          color: 'info',
        });
        await message.channel.send({ embeds: [embed] }).catch(() => {});
      }
      return;
    }

    if (!(await isCommandEnabled(client, message.guild.id, resolvePrefixAccessKey(command.data, args), command.category))) {
      const embed = createEmbed({
        title: 'Command Disabled',
        description: 'This command has been disabled for this server.',
        color: 'error',
      });
      await message.channel.send({ embeds: [embed] }).catch(() => {});
      return;
    }

    const mockInteractionForProtection = {
      guildId: message.guild.id,
      user: message.author,
    };
    const abuseProtection = await enforceAbuseProtection(
      mockInteractionForProtection,
      command,
      resolvedCommandName,
    );
    if (!abuseProtection.allowed) {
      const formattedCooldown = formatCooldownDuration(abuseProtection.remainingMs);
      const embed = createEmbed({
        title: 'Command Cooldown',
        description: `This command is on cooldown. Please wait ${formattedCooldown} before trying again.`,
        color: 'error',
      });
      await message.channel.send({ embeds: [embed] }).catch(() => {});
      return;
    }

    logger.info(`Executing prefix command: ${prefix}${commandName} (resolved to ${resolvedCommandName}) by ${message.author.tag}`);
    
    await executePrefixCommand(command, message, args, client, prefix);
  } catch (error) {
    logger.error('Error handling prefix command:', error);
  }
}

async function handleCountingGame(message, client) {
  try {
    const config = await getCountingGameConfig(client, message.guild.id);
    if (!config.enabled || !config.channelId || message.channel.id !== config.channelId) {
      return false;
    }

    const content = message.content.trim();
    const validCount = isValidCountingMessage(content, config);
    const invalidAttempt = !validCount || message.author.id === config.lastUserId;

    if (invalidAttempt) {
      await message.delete().catch(() => {});
      await saveCountingGameConfig(client, message.guild.id, {
        ...config,
        nextNumber: 1,
        lastUserId: null,
        currentStreak: 0,
      });

      const failureMessage = await message.channel.send(`❌ Count broken by <@${message.author.id}>. The sequence has been reset to **1**.`);
      setTimeout(() => {
        failureMessage.delete().catch(() => {});
      }, 10000);

      return true;
    }

    await recordCorrectCount(client, message.guild.id, message.author.id);
    return true;
  } catch (error) {
    logger.error('Error handling counting game:', error);
    return false;
  }
}

async function handleLeveling(message, client) {
  try {
    const rateLimitKey = `xp-event:${message.guild.id}:${message.author.id}`;
    const canProcess = await checkRateLimit(rateLimitKey, MESSAGE_XP_RATE_LIMIT_ATTEMPTS, MESSAGE_XP_RATE_LIMIT_WINDOW_MS);
    if (!canProcess) {
      return;
    }

    const levelingConfig = await getLevelingConfig(client, message.guild.id);
    
    if (!levelingConfig?.enabled) {
      return;
    }

    if (levelingConfig.ignoredChannels?.includes(message.channel.id)) {
      return;
    }

    if (levelingConfig.ignoredRoles?.length > 0) {
      const member = await message.guild.members.fetch(message.author.id).catch(() => {
        return null;
      });
      if (member && member.roles.cache.some(role => levelingConfig.ignoredRoles.includes(role.id))) {
        return;
      }
    }

    if (levelingConfig.blacklistedUsers?.includes(message.author.id)) {
      return;
    }

    if (!message.content || message.content.trim().length === 0) {
      return;
    }

    const userData = await getUserLevelData(client, message.guild.id, message.author.id);

    const cooldownTime = levelingConfig.xpCooldown || 60;
    const now = Date.now();
    const timeSinceLastMessage = now - (userData.lastMessage || 0);

    if (timeSinceLastMessage < cooldownTime * 1000) {
      return;
    }

    const minXP = levelingConfig.xpRange?.min || levelingConfig.xpPerMessage?.min || 15;
    const maxXP = levelingConfig.xpRange?.max || levelingConfig.xpPerMessage?.max || 25;

    const safeMinXP = Math.max(1, minXP);
    const safeMaxXP = Math.max(safeMinXP, maxXP);

    const xpToGive = Math.floor(Math.random() * (safeMaxXP - safeMinXP + 1)) + safeMinXP;

    let finalXP = xpToGive;
    if (levelingConfig.xpMultiplier && levelingConfig.xpMultiplier > 1) {
      finalXP = Math.floor(finalXP * levelingConfig.xpMultiplier);
    }

    const result = await addXp(client, message.guild, message.member, finalXP);
    
    if (result.success && result.leveledUp) {
      logger.info(
        `${message.author.tag} leveled up to level ${result.level} in ${message.guild.name}`
      );
    }
  } catch (error) {
    logger.error('Error handling leveling for message:', error);
  }
}

const activeAiSessions = new Set();

async function handleAIChat(message, client) {
  try {
    const config = await getAIConfig(message.guild.id);
    if (!config.enabled) return false;

    const isAiChannel = config.channel_id && message.channel.id === config.channel_id;
    const isBotMentioned = message.mentions.has(client.user);

    const content = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
    if (!content) return false;

    const lowerContent = content.toLowerCase();
    const sessionKey = `${message.guild.id}-${message.channel.id}`;

    const isWakeWord = /\bdg\b/i.test(lowerContent);
    const isSleepWord = /^(thanks|alright|ok bye|bye|goodbye|cya|see ya|ok|okay)\b/i.test(lowerContent) || 
                        /\b(thanks dg|bye dg|alright dg|ok dg)\b/i.test(lowerContent);

    if (isAiChannel || isBotMentioned) {
      if (isWakeWord) {
        activeAiSessions.add(sessionKey);
      } else if (!activeAiSessions.has(sessionKey) && !isBotMentioned) {
        // If the bot isn't active in this channel, wasn't just woken up, and wasn't mentioned, ignore the message
        return false;
      }

      await message.channel.sendTyping();

      const response = await generateAIResponse(message.guild.id, content, config.system_prompt);

      // If the response is over 2000 chars, we need to split it, but for now we'll just substring it to be safe
      const safeResponse = response.length > 2000 ? response.substring(0, 1997) + '...' : response;

      await message.reply({ content: safeResponse });

      // Put the bot to sleep in this channel if a sleep word was used
      if (isSleepWord) {
        activeAiSessions.delete(sessionKey);
      }

      return true;
    }

    return false;
  } catch (error) {
    logger.error('Error handling AI chat:', error);
    return false;
  }
}