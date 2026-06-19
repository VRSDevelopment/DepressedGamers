import { SlashCommandBuilder, ChannelType, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { getAIConfig, saveAIConfig } from '../../services/aiService.js';
import { createEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

export default {
    category: 'Utility',
    data: new SlashCommandBuilder()
        .setName('ai')
        .setDescription('Configure the AI chatbot for this server')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .setDMPermission(false)
        .addSubcommand(subcommand =>
            subcommand
                .setName('setup')
                .setDescription('Set up the AI chatbot')
                .addChannelOption(option =>
                    option.setName('channel')
                        .setDescription('The channel where the AI will reply to messages (optional)')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(false))
                .addStringOption(option =>
                    option.setName('system_prompt')
                        .setDescription('Custom personality or instructions for the AI')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('manage')
                .setDescription('Manage the AI chatbot settings')
                .addBooleanOption(option =>
                    option.setName('enabled')
                        .setDescription('Enable or disable the AI chatbot')
                        .setRequired(true))),

    async execute(interaction) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction, { ephemeral: true });
        if (!deferSuccess) return;

        try {
            const subcommand = interaction.options.getSubcommand();
            const guildId = interaction.guildId;
            const currentConfig = await getAIConfig(guildId);

            if (subcommand === 'setup') {
                const channel = interaction.options.getChannel('channel');
                const systemPrompt = interaction.options.getString('system_prompt');

                const newConfig = {
                    ...currentConfig,
                    enabled: true,
                    channel_id: channel ? channel.id : currentConfig.channel_id,
                    system_prompt: systemPrompt !== null ? systemPrompt : currentConfig.system_prompt
                };

                const success = await saveAIConfig(guildId, newConfig);

                if (success) {
                    const embed = createEmbed({
                        title: '🤖 AI Chatbot Setup Complete',
                        description: 'The AI chatbot has been successfully configured and enabled.',
                        color: 'success'
                    }).addFields(
                        { name: 'Channel', value: newConfig.channel_id ? `<#${newConfig.channel_id}>` : 'None (Use mentions)', inline: true },
                        { name: 'System Prompt', value: newConfig.system_prompt ? 'Custom' : 'Default', inline: true }
                    );

                    await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
                } else {
                    throw new Error('Database save failed');
                }
            } else if (subcommand === 'manage') {
                const enabled = interaction.options.getBoolean('enabled');

                const newConfig = {
                    ...currentConfig,
                    enabled: enabled
                };

                const success = await saveAIConfig(guildId, newConfig);

                if (success) {
                    const embed = createEmbed({
                        title: '🤖 AI Chatbot Settings Updated',
                        description: `The AI chatbot is now **${enabled ? 'enabled' : 'disabled'}**.`,
                        color: enabled ? 'success' : 'error'
                    });

                    await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
                } else {
                    throw new Error('Database save failed');
                }
            }
        } catch (error) {
            logger.error('Error in /ai command:', error);
            const errorEmbed = createEmbed({
                title: 'Error',
                description: 'An error occurred while configuring the AI chatbot. Please try again later.',
                color: 'error'
            });
            await InteractionHelper.safeEditReply(interaction, { embeds: [errorEmbed] });
        }
    }
};
