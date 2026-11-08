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

// --- CONFIGURATION (Your Updated Channel IDs) ---
const STAFF_LIST_CHANNEL_ID = '1568917305336004694'; // Staff list updates here every 15 mins
const QUOTA_LOGS_CHANNEL_ID = '1568917352710676601'; // Quota check reports posted here
const PUNISHMENT_LOGS_ID    = '1549094352406450272'; // People log punishments here

// Replace these placeholders with your actual Discord Role IDs and weekly quotas:
const RANK_CONFIG = [
    { id: 'SENIOR_ADMIN_ROLE_ID', name: 'Senior Administrator', quota: 0 },
    { id: 'ADMIN_ROLE_ID', name: 'Administrator', quota: 15 },
    { id: 'JUNIOR_ADMIN_ROLE_ID', name: 'Junior Administrator', quota: 12 },
    { id: 'SENIOR_MOD_ROLE_ID', name: 'Senior Moderator', quota: 10 },
    { id: 'MOD_ROLE_ID', name: 'Moderator', quota: 8 },
    { id: 'JUNIOR_MOD_ROLE_ID', name: 'Junior Moderator', quota: 5 },
    { id: 'HELPER_ROLE_ID', name: 'Helper', quota: 3 },
    { id: 'TRIAL_STAFF_ROLE_ID', name: 'Trial Staff', quota: 2 }
];
// ------------------------------------------------

let cachedStaffMessageId = null;

// Helper function to return status emoji
function getStatusEmoji(status) {
    switch (status) {
        case 'online': return '🟢';
        case 'idle': return '🟡';
        case 'dnd': return '🔴';
        default: return '⚪'; // offline
    }
}

client.once('ready', () => {
    console.log(`Staff Bot online as ${client.user.tag}`);

    // 1. Auto-update the staff list embed every 15 minutes
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

    // 2. Auto-check quotas every Sunday at midnight (or change schedule as needed)
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

// Function to generate and update the staff list layout
async function postOrUpdateStaffList(guild, channel) {
    await guild.members.fetch({ withPresences: true });

    let totalStaffCount = 0;
    let descriptionText = '';

    for (const rank of RANK_CONFIG) {
        const role = guild.roles.cache.get(rank.id);
        
        if (!role) {
            descriptionText += `### 🛡️ ${rank.name} (0)\n> *No staff at this rank*\n\n`;
            continue;
        }

        const members = role.members;
        totalStaffCount += members.size;

        descriptionText += `### 🛡️ ${rank.name} (${members.size})\n`;
        
        if (members.size === 0) {
            descriptionText += `> *No staff at this rank*\n\n`;
        } else {
            for (const [memberId, member] of members) {
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

    if (cachedStaffMessageId) {
        try {
            const oldMsg = await channel.messages.fetch(cachedStaffMessageId);
            if (oldMsg) {
                await oldMsg.edit({ embeds: [embed] });
                return;
            }
        } catch (e) {
            // Message was deleted, send a fresh one below
        }
    }

    const newMsg = await channel.send({ embeds: [embed] });
    cachedStaffMessageId = newMsg.id;
}

// Function to calculate and post quota evaluations
async function runQuotaEvaluation(guild, targetChannel) {
    const punishmentChannel = guild.channels.cache.get(PUNISHMENT_LOGS_ID);
    if (!punishmentChannel) {
        await targetChannel.send('❌ Quota error: Punishment logs channel (`1549094352406450272`) could not be found.');
        return;
    }

    const fetchedLogs = await punishmentChannel.messages.fetch({ limit: 100 });
    const staffActionCounts = {};

    fetchedLogs.forEach(log => {
        const authorId = log.author.id;
        staffActionCounts[authorId] = (staffActionCounts[authorId] || 0) + 1;
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

// Manual Command triggers
client.on('messageCreate', async message => {
    if (!message.guild || message.author.bot) return;

    // 1. Force refresh staff list: "!refreshstaff"
    if (message.content === '!refreshstaff' && message.member.permissions.has('Administrator')) {
        const channel = message.guild.channels.cache.get(STAFF_LIST_CHANNEL_ID);
        if (!channel) return message.reply('❌ Staff list channel not found.');
        
        await postOrUpdateStaffList(message.guild, channel);
        await message.reply('✅ Staff list manually refreshed!');
    }

    // 2. Force manual quota check: "!checkquota" (Posts result to quota-logs channel)
    if (message.content === '!checkquota' && message.member.permissions.has('ManageGuild')) {
        const quotaChannel = message.guild.channels.cache.get(QUOTA_LOGS_CHANNEL_ID);
        if (!quotaChannel) return message.reply('❌ Quota logs channel not found.');

        await message.reply('🔄 Running quota evaluation and posting to quota logs...');
        await runQuotaEvaluation(message.guild, quotaChannel);
    }
});

client.login(process.env.BOT_TOKEN);
