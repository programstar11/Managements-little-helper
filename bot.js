const {
    Client,
    GatewayIntentBits,
    EmbedBuilder,
    PermissionsBitField
} = require('discord.js');
const cron = require('node-cron');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// --- CONFIGURATION ---
const STAFF_LIST_CHANNEL_ID = '1568897439325356124';
const QUOTA_LOGS_CHANNEL_ID = '1568759470111334591';
const LOGS_PARENT_CHANNEL_ID = '1568814017479311381';

const LOG_THREADS = [
    { id: '1568816126333554769', key: 'discordBans', label: 'Discord Bans' },
    { id: '1568816007005479003', key: 'discordMutes', label: 'Discord Mutes' },
    { id: '1568815563898355782', key: 'ingameMutes', label: 'In-Game Mutes' },
    { id: '1568815272662409366', key: 'ingameBans', label: 'In-Game Bans' }
];

const STAFF_LIST_RANKS = [
    { id: '1568759466252308497', name: 'Owner' },
    { id: '1573407656247304303', name: 'Co-Owner' },
    { id: '1568759466252308496', name: 'Director' },
    { id: '1568759466227269647', name: 'Developer' },
    { id: '1568759466227269645', name: 'Sr. Admin' },
    { id: '1568759466227269644', name: 'Admin' },
    { id: '1568759466185334984', name: 'Sr. Moderator' },
    { id: '1568759466185334983', name: 'Moderator' },
    { id: '1568759466185334982', name: 'Helper' }
];

// Adjust quota targets per rank as needed (0 = exempt/no minimum required)
const QUOTA_RANKS = [
    { id: '1568759466227269645', name: 'Sr. Admin', quota: 0 },
    { id: '1568759466227269644', name: 'Admin', quota: 15 },
    { id: '1568759466185334984', name: 'Sr. Moderator', quota: 10 },
    { id: '1568759466185334983', name: 'Moderator', quota: 8 },
    { id: '1568759466185334982', name: 'Helper', quota: 5 }
];

// Excluded from quota tracking
const EXCLUDED_QUOTA_ROLE_IDS = [
    '1568759466252308497', // Owner
    '1573407656247304303', // Co-Owner
    '1568759466252308496', // Director
    '1568759466227269647'  // Developer
];

let cachedStaffMessageId = null;

function getStatusEmoji(status) {
    switch (status) {
        case 'online': return '🟢';
        case 'idle': return '🟡';
        case 'dnd': return '🔴';
        default: return '⚪';
    }
}

function getStatusLabel(status) {
    switch (status) {
        case 'online': return 'Online';
        case 'idle': return 'Idle';
        case 'dnd': return 'Do Not Disturb';
        default: return 'Offline';
    }
}

async function resolveLogThread(guild, threadConfig) {
    let thread = guild.channels.cache.get(threadConfig.id);
    if (!thread) {
        try {
            thread = await guild.channels.fetch(threadConfig.id);
        } catch (e) {
            thread = null;
        }
    }

    if (!thread && LOGS_PARENT_CHANNEL_ID) {
        try {
            const parent = guild.channels.cache.get(LOGS_PARENT_CHANNEL_ID) || await guild.channels.fetch(LOGS_PARENT_CHANNEL_ID);
            if (parent && parent.threads) {
                const active = await parent.threads.fetchActive();
                thread = active.threads.get(threadConfig.id);
                if (!thread) {
                    const archived = await parent.threads.fetchArchived();
                    thread = archived.threads.get(threadConfig.id);
                }
            }
        } catch (e) {}
    }

    return thread;
}

client.once('ready', () => {
    console.log(`Staff Bot online as ${client.user.tag}`);

    // Auto-update staff roster every 30 minutes
    cron.schedule('*/30 * * * *', async () => {
        try {
            const guild = client.guilds.cache.first();
            if (!guild) return;
            const channel = guild.channels.cache.get(STAFF_LIST_CHANNEL_ID) || await guild.channels.fetch(STAFF_LIST_CHANNEL_ID).catch(() => null);
            if (!channel) return;

            await postOrUpdateStaffList(guild, channel);
        } catch (err) {
            console.error('Error auto-updating staff list:', err);
        }
    });

    // Auto-check quotas every Sunday at 12:00 PM
    cron.schedule('0 12 * * 0', async () => {
        try {
            const guild = client.guilds.cache.first();
            if (!guild) return;
            const channel = guild.channels.cache.get(QUOTA_LOGS_CHANNEL_ID) || await guild.channels.fetch(QUOTA_LOGS_CHANNEL_ID).catch(() => null);
            if (!channel) return;

            await runQuotaEvaluation(guild, channel);
        } catch (err) {
            console.error('Error in automated quota check:', err);
        }
    });
});

async function postOrUpdateStaffList(guild, channel) {
    await guild.members.fetch({ withPresences: true });

    let totalStaffCount = 0;
    let presentCount = 0;
    let absentCount = 0;
    let descriptionText = '';
    const accountedMembers = new Set();

    for (const rank of STAFF_LIST_RANKS) {
        const role = guild.roles.cache.get(rank.id);
        if (!role) {
            descriptionText += `### 🛡️ ${rank.name} (0)\n> *Role not found*\n\n`;
            continue;
        }

        const validMembers = role.members.filter(member => !member.user.bot && !accountedMembers.has(member.id));
        totalStaffCount += validMembers.size;

        descriptionText += `### 🛡️ ${rank.name} (${validMembers.size})\n`;

        if (validMembers.size === 0) {
            descriptionText += `> *No staff at this rank*\n\n`;
        } else {
            for (const [, member] of validMembers) {
                accountedMembers.add(member.id);

                const ign = member.displayName.includes('|')
                    ? member.displayName.split('|')[1].trim()
                    : member.displayName;
                const status = member.presence?.status || 'offline';
                const emoji = getStatusEmoji(status);
                const label = getStatusLabel(status);

                if (status !== 'offline') {
                    presentCount++;
                } else {
                    absentCount++;
                }

                descriptionText += `${emoji} ${member} — **${ign}** *(${label})*\n`;
            }
            descriptionText += `\n`;
        }
    }

    const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle('📊 Staff Activity · Server Roster')
        .setDescription(descriptionText.trim() || '*No staff members found.*')
        .addFields(
            { name: '🟢 Present', value: `${presentCount}`, inline: true },
            { name: '⚪ Absent', value: `${absentCount}`, inline: true },
            { name: '👥 Total Staff', value: `${totalStaffCount}`, inline: true }
        )
        .setFooter({ text: `Staff Roster • Updated ${new Date().toISOString().split('T')[0]}` })
        .setTimestamp();

    if (!cachedStaffMessageId) {
        try {
            const messages = await channel.messages.fetch({ limit: 15 });
            const existingBotMsg = messages.find(m => m.author.id === client.user.id && m.embeds.length > 0);
            if (existingBotMsg) cachedStaffMessageId = existingBotMsg.id;
        } catch (e) {}
    }

    if (cachedStaffMessageId) {
        try {
            const oldMsg = await channel.messages.fetch(cachedStaffMessageId);
            if (oldMsg) {
                await oldMsg.edit({ embeds: [embed] });
                return;
            }
        } catch (e) {
            cachedStaffMessageId = null;
        }
    }

    const newMsg = await channel.send({ embeds: [embed] });
    cachedStaffMessageId = newMsg.id;
}

async function runQuotaEvaluation(guild, targetChannel, triggerMessage = null) {
    const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const staffStats = {}; // userId -> { total, discordBans, discordMutes, ingameMutes, ingameBans }

    const ensureUserStats = (userId) => {
        if (!staffStats[userId]) {
            staffStats[userId] = {
                total: 0,
                discordBans: 0,
                discordMutes: 0,
                ingameMutes: 0,
                ingameBans: 0
            };
        }
        return staffStats[userId];
    };

    for (const threadConfig of LOG_THREADS) {
        const thread = await resolveLogThread(guild, threadConfig);
        if (!thread) {
            console.warn(`Could not resolve log thread: ${threadConfig.label} (${threadConfig.id})`);
            continue;
        }

        try {
            const messages = await thread.messages.fetch({ limit: 100 });
            messages.forEach(msg => {
                if (msg.createdTimestamp >= oneWeekAgo && msg.author && !msg.author.bot) {
                    const stats = ensureUserStats(msg.author.id);
                    stats[threadConfig.key] += 1;
                    stats.total += 1;
                }
            });
        } catch (err) {
            console.error(`Failed fetching messages from ${threadConfig.label}:`, err);
        }
    }

    await guild.members.fetch();

    const accountedQuotaMembers = new Set();

    for (const roleId of EXCLUDED_QUOTA_ROLE_IDS) {
        const role = guild.roles.cache.get(roleId);
        if (role) {
            role.members.forEach(member => accountedQuotaMembers.add(member.id));
        }
    }

    const passedList = [];
    const failedList = [];

    for (const rank of QUOTA_RANKS) {
        const role = guild.roles.cache.get(rank.id);
        if (!role) continue;

        const validMembers = role.members.filter(member => !member.user.bot && !accountedQuotaMembers.has(member.id));
        if (validMembers.size === 0) continue;

        for (const [memberId, member] of validMembers) {
            accountedQuotaMembers.add(member.id);

            const stats = staffStats[memberId] || {
                total: 0,
                discordBans: 0,
                discordMutes: 0,
                ingameMutes: 0,
                ingameBans: 0
            };

            const passed = rank.quota === 0 || stats.total >= rank.quota;
            const breakdown = `IG Bans: **${stats.ingameBans}** • IG Mutes: **${stats.ingameMutes}** • DC Bans: **${stats.discordBans}** • DC Mutes: **${stats.discordMutes}**`;
            const entry = `${member} **(${rank.name})** — **${stats.total} / ${rank.quota}** logs\n└ ${breakdown}`;

            if (passed) {
                passedList.push({ total: stats.total, text: entry });
            } else {
                failedList.push({ total: stats.total, text: entry });
            }
        }
    }

    passedList.sort((a, b) => b.total - a.total);
    failedList.sort((a, b) => b.total - a.total);

    let description = `**Period:** Last 7 Days (Sunday → Sunday)\n\n`;

    description += `### 🟢 Passed & Exempt (${passedList.length})\n`;
    description += passedList.length > 0
        ? passedList.map(item => `• ${item.text}`).join('\n\n')
        : `> *None*\n`;

    description += `\n\n### 🔴 Failed Quota (${failedList.length})\n`;
    description += failedList.length > 0
        ? failedList.map(item => `• ${item.text}`).join('\n\n')
        : `> *None — All evaluated staff met their quota!*\n`;

    const totalEvaluated = passedList.length + failedList.length;
    const passRate = totalEvaluated > 0 ? Math.round((passedList.length / totalEvaluated) * 100) : 100;

    const leaderboardEmbed = new EmbedBuilder()
        .setColor(failedList.length > 0 ? 0xe74c3c : 0x2ecc71)
        .setTitle('📊 Weekly Staff Quota Leaderboard')
        .setDescription(description)
        .addFields(
            { name: '👥 Evaluated', value: `${totalEvaluated}`, inline: true },
            { name: '🟢 Passed', value: `${passedList.length}`, inline: true },
            { name: '🔴 Failed', value: `${failedList.length}`, inline: true },
            { name: '📈 Pass Rate', value: `${passRate}%`, inline: true }
        )
        .setFooter({ text: `Weekly Quota Evaluation • Automated Report` })
        .setTimestamp();

    if (triggerMessage) {
        await triggerMessage.edit({ content: null, embeds: [leaderboardEmbed] });
    } else {
        await targetChannel.send({ embeds: [leaderboardEmbed] });
    }
}

client.on('messageCreate', async message => {
    if (!message.guild || message.author.bot) return;

    if (message.content === '!refreshstaff') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;

        const channel = message.guild.channels.cache.get(STAFF_LIST_CHANNEL_ID) || await message.guild.channels.fetch(STAFF_LIST_CHANNEL_ID).catch(() => null);
        if (!channel) return message.reply('❌ Staff list channel not found.');

        const statusMsg = await message.reply('🔄 Refreshing staff roster...');
        await postOrUpdateStaffList(message.guild, channel);
        await statusMsg.edit('✅ Staff roster updated.');
        return;
    }

    if (message.content === '!checkquota') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return;

        const quotaChannel = message.guild.channels.cache.get(QUOTA_LOGS_CHANNEL_ID) || await message.guild.channels.fetch(QUOTA_LOGS_CHANNEL_ID).catch(() => null);
        if (!quotaChannel) return message.reply('❌ Quota logs channel not found.');

        const statusMsg = await message.reply('🔄 Calculating weekly quota leaderboard...');
        await runQuotaEvaluation(message.guild, quotaChannel, statusMsg);
        return;
    }
});

client.login(process.env.BOT_TOKEN);
