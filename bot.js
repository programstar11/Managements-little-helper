const { 
    Client, 
    GatewayIntentBits, 
    EmbedBuilder 
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
const STAFF_LIST_CHANNEL_ID = '1568917305336004694'; 
const QUOTA_LOGS_CHANNEL_ID = '1568917352710676601'; 
const PUNISHMENT_LOGS_ID    = '1549094352406450272'; 

// Ordered from highest rank to lowest rank
const RANK_CONFIG = [
    { id: '1550211533332811866', name: 'Senior Administrator', quota: 0 },
    { id: '1549094351802474619', name: 'Administrator', quota: 15 },
    { id: '1549094351794348182', name: 'Senior Moderator', quota: 10 },
    { id: '1549094351794348181', name: 'Moderator', quota: 8 },
    { id: '1549094351794348180', name: 'Helper', quota: 3 },
    { id: '1549094351794348178', name: 'Trainee', quota: 2 }
];
// ------------------------------------------------

let cachedStaffMessageId = null;

function getStatusEmoji(status) {
    switch (status) {
        case 'online': return '🟢';
        case 'idle': return '🟡';
        case 'dnd': return '🔴';
        default: return '⚪'; 
    }
}

client.once('ready', () => {
    console.log(`Staff Bot online as ${client.user.tag}`);

    // Auto-update staff list every 15 minutes
    cron.schedule('*/15 * * * *', async () => {
        try {
            const guild = client.guilds.cache.first();
            if (!guild) return;
            const channel = guild.channels.cache.get(STAFF_LIST_CHANNEL_ID);
            if (!channel) return;

            await postOrUpdateStaffList(guild, channel);
        } catch (err) {
            console.error('Error auto-updating staff list:', err);
        }
    });

    // Auto-check quotas every Sunday at midnight
    cron.schedule('0 0 * * 0', async () => {
        try {
            const guild = client.guilds.cache.first();
            if (!guild) return;
            const channel = guild.channels.cache.get(QUOTA_LOGS_CHANNEL_ID);
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
    let descriptionText = '';
    const accountedMembers = new Set(); // Prevents members from showing up in multiple lower ranks

    for (const rank of RANK_CONFIG) {
        const role = guild.roles.cache.get(rank.id);
        
        if (!role) {
            descriptionText += `### 🛡️ ${rank.name} (0)\n> *No staff at this rank*\n\n`;
            continue;
        }

        // Filter out members already accounted for in a higher rank
        const validMembers = role.members.filter(member => !accountedMembers.has(member.id));
        
        totalStaffCount += validMembers.size;
        descriptionText += `### 🛡️ ${rank.name} (${validMembers.size})\n`;
        
        if (validMembers.size === 0) {
            descriptionText += `> *No staff at this rank*\n\n`;
        } else {
            for (const [memberId, member] of validMembers) {
                accountedMembers.add(member.id); // Mark as accounted for

                let ign = member.displayName.includes('|') ? member.displayName.split('|')[1].trim() : member.user.username;
                const status = member.presence?.status || 'offline';
                const emoji = getStatusEmoji(status);

                descriptionText += `${emoji} <@${member.id}> - ${ign}\n`;
            }
            descriptionText += `\n`;
        }
    }

    const embed = new EmbedBuilder()
        .setTitle('Staff Team')
        .setDescription(descriptionText)
        .setColor(0xfaa61a)
        .setFooter({ text: `Staff Team | ${totalStaffCount} staff members | Automatically updated` })
        .setTimestamp();

    // Try editing the cached message; if it fails or doesn't exist, send a new one
    if (cachedStaffMessageId) {
        try {
            const oldMsg = await channel.messages.fetch(cachedStaffMessageId);
            if (oldMsg) {
                await oldMsg.edit({ embeds: [embed] });
                return;
            }
        } catch (e) {
            // Message was deleted manually, will send a new one below
        }
    }

    const newMsg = await channel.send({ embeds: [embed] });
    cachedStaffMessageId = newMsg.id;
}

async function runQuotaEvaluation(guild, targetChannel) {
    const punishmentChannel = guild.channels.cache.get(PUNISHMENT_LOGS_ID);
    if (!punishmentChannel) {
        await targetChannel.send('❌ Quota error: Punishment logs channel could not be found.');
        return;
    }

    const fetchedLogs = await punishmentChannel.messages.fetch({ limit: 100 });
    const staffActionCounts = {};

    fetchedLogs.forEach(log => {
        // Track author ID
        let userId = log.author.id;
        
        // Also check if staff member is mentioned or named inside embeds/content if logged via another webhook/bot
        if (log.embeds && log.embeds.length > 0) {
            const embedText = log.embeds[0].description || '';
            const embedTitle = log.embeds[0].title || '';
            // If the message contains a user mention or text tag, we can attribute it
            // Simple approach: count author, or check content mentions
        }

        staffActionCounts[userId] = (staffActionCounts[userId] || 0) + 1;
    });

    await guild.members.fetch();
    let report = '📊 **Automated Weekly Quota Evaluation Report**\n\n';

    for (const rank of RANK_CONFIG) {
        const role = guild.roles.cache.get(rank.id);
        if (!role || role.members.size === 0) continue;

        report += `**Rank: ${rank.name}** (Target: ${rank.quota} logs/week)\n`;
        
        for (const [memberId, member] of role.members) {
            const count = staffActionCounts[memberId] || 0;
            const passed = count >= rank.quota;
            report += `• ${member} — **${count}** logs (${passed ? '🟢 Passed' : '🔴 Failed'})\n`;
        }
        report += '\n';
    }

    await targetChannel.send(report);
}

client.on('messageCreate', async message => {
    if (!message.guild || message.author.bot) return;

    if (message.content === '!refreshstaff' && message.member.permissions.has('Administrator')) {
        const channel = message.guild.channels.cache.get(STAFF_LIST_CHANNEL_ID);
        if (!channel) return message.reply('❌ Staff list channel not found.');
        
        await postOrUpdateStaffList(message.guild, channel);
        await message.reply('✅ Staff list successfully refreshed!');
    }

    if (message.content === '!checkquota' && message.member.permissions.has('ManageGuild')) {
        const quotaChannel = message.guild.channels.cache.get(QUOTA_LOGS_CHANNEL_ID);
        if (!quotaChannel) return message.reply('❌ Quota logs channel not found.');

        await message.reply('🔄 Running quota evaluation and posting to quota logs...');
        await runQuotaEvaluation(message.guild, quotaChannel);
    }
});

client.login(process.env.BOT_TOKEN);
