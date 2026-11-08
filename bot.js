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
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// --- CONFIGURATION: PUT YOUR EXACT DISCORD IDs HERE ---
const STAFF_LIST_CHANNEL_ID = '1568917305336004694'; 
const PUNISHMENT_LOGS_ID = '1568917352710676601';

// Map your role IDs to their titles and minimum weekly punishment quotas
const RANK_CONFIG = {
    'SENIOR_ADMIN_ROLE_ID': { name: 'Senior Administrator', quota: 0 },
    'ADMIN_ROLE_ID': { name: 'Administrator', quota: 15 },
    'JUNIOR_ADMIN_ROLE_ID': { name: 'Junior Administrator', quota: 12 },
    'SENIOR_MOD_ROLE_ID': { name: 'Senior Moderator', quota: 10 },
    'MOD_ROLE_ID': { name: 'Moderator', quota: 8 },
    'JUNIOR_MOD_ROLE_ID': { name: 'Junior Moderator', quota: 5 },
    'HELPER_ROLE_ID': { name: 'Helper', quota: 3 },
    'TRIAL_STAFF_ROLE_ID': { name: 'Trial Staff', quota: 2 }
};
// ------------------------------------------------------

let cachedStaffMessageId = null;

client.once('ready', () => {
    console.log(`Standalone Staff Bot online as ${client.user.tag}`);

    // Automatically update the public staff list every 6 hours
    cron.schedule('0 */6 * * *', async () => {
        try {
            const guild = client.guilds.cache.first();
            if (!guild) return;
            const channel = guild.channels.cache.get(STAFF_LIST_CHANNEL_ID);
            if (!channel) return;

            await postOrUpdateStaffList(guild, channel);
        } catch (err) {
            console.error('Error in scheduled staff list update:', err);
        }
    });
});

// Function to generate and refresh the staff list layout
async function postOrUpdateStaffList(guild, channel) {
    await guild.members.fetch();

    let totalStaffCount = 0;
    let descriptionText = '';

    for (const [roleId, data] of Object.entries(RANK_CONFIG)) {
        const role = guild.roles.cache.get(roleId);
        if (!role) continue;

        const members = role.members;
        totalStaffCount += members.size;

        descriptionText += `### 🛡️ ${data.name} (${members.size})\n`;
        
        if (members.size === 0) {
            descriptionText += `> *No staff at this rank*\n\n`;
        } else {
            for (const [memberId, member] of members) {
                // Extracts custom IGN if nickname is formatted like "Rank | IGN", otherwise uses username
                let ign = member.displayName.includes('|') ? member.displayName.split('|')[1].trim() : member.user.username;
                descriptionText += `<@${member.id}> - ${ign}\n`;
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

    // Try editing the previous message if it exists, otherwise send a new one
    if (cachedStaffMessageId) {
        try {
            const oldMsg = await channel.messages.fetch(cachedStaffMessageId);
            if (oldMsg) {
                await oldMsg.edit({ embeds: [embed] });
                return;
            }
        } catch (e) {
            // Message was likely deleted manually; fallback to sending a fresh one
        }
    }

    const newMsg = await channel.send({ embeds: [embed] });
    cachedStaffMessageId = newMsg.id;
}

// Command Handler for Quota Evaluation and Manual Roster Refreshes
client.on('messageCreate', async message => {
    if (!message.guild || message.author.bot) return;

    // Manual command to post/refresh the staff list right now: "!refreshstaff"
    if (message.content === '!refreshstaff' && message.member.permissions.has('Administrator')) {
        const channel = message.guild.channels.cache.get(STAFF_LIST_CHANNEL_ID);
        if (!channel) return message.reply('❌ Staff list channel not found.');
        await postOrUpdateStaffList(message.guild, channel);
        await message.reply('✅ Staff list has been successfully refreshed!');
    }

    // Automatic Quota Check Command: "!checkquota"
    if (message.content === '!checkquota' && message.member.permissions.has('ManageGuild')) {
        const statusMsg = await message.reply('🔄 Analyzing punishment logs to evaluate staff activity over recent entries...');

        const punishmentChannel = message.guild.channels.cache.get(PUNISHMENT_LOGS_ID);
        if (!punishmentChannel) {
            return statusMsg.edit('❌ Error: Punishment logs channel could not be found.');
        }

        // Fetch recent logs to calculate counts per staff member
        const fetchedLogs = await punishmentChannel.messages.fetch({ limit: 100 });
        const staffActionCounts = {};

        fetchedLogs.forEach(log => {
            const authorId = log.author.id;
            staffActionCounts[authorId] = (staffActionCounts[authorId] || 0) + 1;
        });

        await message.guild.members.fetch();
        let report = '📊 **Automatic Weekly Quota Evaluation Report**\n\n';

        for (const [roleId, data] of Object.entries(RANK_CONFIG)) {
            const role = message.guild.roles.cache.get(roleId);
            if (!role || role.members.size === 0) continue;

            report += `**Rank: ${data.name}** (Target: ${data.quota} actions/week)\n`;
            
            for (const [memberId, member] of role.members) {
                const count = staffActionCounts[memberId] || 0;
                const passed = count >= data.quota;
                report += `• ${member} — **${count}** logs (${passed ? '🟢 Passed' : '🔴 Failed'})\n`;
            }
            report += '\n';
        }

        await statusMsg.edit(report);
    }
});

client.login(process.env.BOT_TOKEN);
