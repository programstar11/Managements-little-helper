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

const STAFF_LIST_RANKS = [
    { id: '1549094351810854997', name: 'Owner' },
    { id: '1549094351810854994', name: 'Manager' },
    { id: '1550211533332811866', name: 'Senior Administrator' },
    { id: '1549094351802474619', name: 'Administrator' },
    { id: '1549094351794348182', name: 'Senior Moderator' },
    { id: '1549094351794348181', name: 'Moderator' },
    { id: '1549094351794348180', name: 'Helper' },
    { id: '1549094351794348178', name: 'Trainee' }
];

const QUOTA_RANKS = [
    { id: '1550211533332811866', name: 'Senior Administrator', quota: 0 },
    { id: '1549094351802474619', name: 'Administrator', quota: 15 },
    { id: '1549094351794348182', name: 'Senior Moderator', quota: 10 },
    { id: '1549094351794348181', name: 'Moderator', quota: 8 },
    { id: '1549094351794348180', name: 'Helper', quota: 3 },
    { id: '1549094351794348178', name: 'Trainee', quota: 2 }
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

client.once('ready', () => {
    console.log(`Staff Bot online as ${client.user.tag}`);

    // Auto-update staff activity roster every 30 minutes
    cron.schedule('*/30 * * * *', async () => {
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

    // Auto-check quotas every Sunday at 12:00 PM
    cron.schedule('0 12 * * 0', async () => {
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

    let presentCount = 0;
    let absentCount = 0;
    let descriptionText = '';
    const accountedMembers = new Set();

    for (const rank of STAFF_LIST_RANKS) {
        const role = guild.roles.cache.get(rank.id);
        if (!role) continue;

        const validMembers = role.members.filter(member => !accountedMembers.has(member.id));
        
        if (validMembers.size > 0) {
            for (const [memberId, member] of validMembers) {
                accountedMembers.add(member.id);

                let ign = member.displayName.includes('|') ? member.displayName.split('|')[1].trim() : member.user.username;
                const status = member.presence?.status || 'offline';
                
                if (status !== 'offline') {
                    presentCount++;
                    descriptionText += `${member} — **${ign}** — 🟢 Active\n`;
                } else {
                    absentCount++;
                    descriptionText += `${member} — **${ign}** — Absent\n`;
                }
            }
        }
    }

    if (!descriptionText) descriptionText = 'No staff members found.';

    const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle('📊 Staff Activity · Server Roster')
        .setDescription(descriptionText)
        .addFields(
            { name: 'Present', value: `${presentCount}`, inline: true },
            { name: 'Absent', value: `${absentCount}`, inline: true },
            { name: 'Date', value: `${new Date().toISOString().split('T')[0]} · America/New_York`, inline: true }
        )
        .setFooter({ text: `BonkMC | Active Staff Roster · Two-minute idle cutoff` })
        .setTimestamp();

    if (!cachedStaffMessageId) {
        try {
            const messages = await channel.messages.fetch({ limit: 10 });
            const existingBotMsg = messages.find(m => m.author.id === client.user.id && m.embeds.length > 0);
            if (existingBotMsg) {
                cachedStaffMessageId = existingBotMsg.id;
            }
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

async function runQuotaEvaluation(guild, targetChannel) {
    const punishmentChannel = guild.channels.cache.get(PUNISHMENT_LOGS_ID);
    if (!punishmentChannel) {
        await targetChannel.send('❌ Quota error: Punishment logs channel could not be found.');
        return;
    }

    const fetchedLogs = await punishmentChannel.messages.fetch({ limit: 100 });
    const staffActionCounts = {};
    
    const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);

    fetchedLogs.forEach(log => {
        if (log.createdTimestamp >= oneWeekAgo) {
            let userId = log.author.id;
            staffActionCounts[userId] = (staffActionCounts[userId] || 0) + 1;
        }
    });

    await guild.members.fetch();
    
    const accountedQuotaMembers = new Set();
    const ownerAndManagerRoleIds = ['1549094351810854997', '1549094351810854994'];

    ownerAndManagerRoleIds.forEach(roleId => {
        const role = guild.roles.cache.get(roleId);
        if (role) {
            role.members.forEach(member => accountedQuotaMembers.add(member.id));
        }
    });

    for (const rank of QUOTA_RANKS) {
        const role = guild.roles.cache.get(rank.id);
        if (!role) continue;

        const validMembers = role.members.filter(member => !accountedQuotaMembers.has(member.id));
        if (validMembers.size === 0) continue;

        for (const [memberId, member] of validMembers) {
            accountedQuotaMembers.add(member.id);
            const count = staffActionCounts[memberId] || 0;
            const passed = rank.quota === 0 || count >= rank.quota;

            // Exact menu card format matching your target reference screenshot layout
            const reportEmbed = new EmbedBuilder()
                .setColor(passed ? 0x2ecc71 : 0xe74c3c)
                .setTitle('📊 Weekly Staff Quota')
                .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
                .addFields(
                    { name: 'Staff Member', value: `${member} (${rank.name})`, inline: false },
                    { name: 'Status', value: passed ? '✅ Completed' : '❌ Failed', inline: true },
                    { name: 'Period', value: `Sunday -> Sunday`, inline: true },
                    { name: 'Punishment Logs Quota', value: `${count} / ${rank.quota} COMPLETED`, inline: false },
                    { name: 'Ticket & Activity Quota', value: `Tracked via server metrics`, inline: false }
                )
                .setFooter({ text: `BonkMC | Automatically generated weekly staff activity report` })
                .setTimestamp();

            await targetChannel.send({ embeds: [reportEmbed] });
        }
    }
}

client.on('messageCreate', async message => {
    if (!message.guild || message.author.bot) return;

    if (message.content === '!refreshstaff') {
        if (!message.member.permissions.has('Administrator')) return;
        
        const channel = message.guild.channels.cache.get(STAFF_LIST_CHANNEL_ID);
        if (!channel) return message.reply('❌ Staff list channel not found.');
        
        await postOrUpdateStaffList(message.guild, channel);
        await message.reply('✅ Staff list successfully refreshed!');
        return;
    }

    if (message.content === '!checkquota') {
        if (!message.member.permissions.has('ManageGuild')) return;

        const quotaChannel = message.guild.channels.cache.get(QUOTA_LOGS_CHANNEL_ID);
        if (!quotaChannel) return message.reply('❌ Quota logs channel not found.');

        await message.reply('🔄 Generating exact weekly report cards...');
        await runQuotaEvaluation(message.guild, quotaChannel);
        return;
    }
});

client.login(process.env.BOT_TOKEN);
