import { fileURLToPath } from 'node:url';
import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder,
  MediaGalleryBuilder, MessageFlags, SectionBuilder, SeparatorBuilder,
  StringSelectMenuBuilder, TextDisplayBuilder,
} from 'discord.js';

export const SUPPORT_TYPES = {
  general: { label: 'General Support', description: 'General questions, bug reports, other inquiries.' },
  management: { label: 'Management Support', description: 'Reporting staff, escalated concerns, management matters.' },
  purchase: { label: 'Purchase Claim', description: 'Claiming a purchase, payment issues, order disputes.' },
};
const text = content => new TextDisplayBuilder().setContent(content);

export function panelPayload(kind, config) {
  const external = kind === 'verification' ? config.verificationBannerUrl : kind === 'dashboard' ? config.dashboardBannerUrl : '';
  const name = kind === 'verification' ? 'verification.webp' : kind === 'careers' ? 'careers.png' : 'dashboard.png';
  const box = new ContainerBuilder().addMediaGalleryComponents(
    new MediaGalleryBuilder().addItems(item => item
      .setURL(external || `attachment://${name}`)
      .setDescription(`.revisonary — ${kind.toUpperCase()} — Design that builds brands.`)),
  );
  if (kind === 'verification') {
    box.addTextDisplayComponents(text('**Verification**'), text(
      'Welcome to **.revisonary**! Click **Verify** below to receive your verified role and gain access to the server. '
      + 'Your new-member role will be removed automatically.',
    )).addSeparatorComponents(new SeparatorBuilder()).addSectionComponents(
      new SectionBuilder().addTextDisplayComponents(text('Verify using the button here:'))
        .setButtonAccessory(new ButtonBuilder().setCustomId('rv:verify')
          .setLabel('Verify').setStyle(ButtonStyle.Secondary)),
    );
  } else if (kind === 'careers') {
    box.addTextDisplayComponents(text('### Careers at .revisonary'), text(
      'Join our team! Choose **Support Staff**, **Management+**, or **Design Team** below. '
      + 'The bot will send your questions privately in DMs. Design applicants can choose GFX, VFX, Discord Services, or multiple specialties.\n\n'
      + 'Your answers go to our review team. You will receive the decision and reason by DM. Please enable DMs from this server.',
    )).addSeparatorComponents(new SeparatorBuilder()).addActionRowComponents(
      new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
        .setCustomId('rv:apply').setPlaceholder('Choose an application').addOptions(
          { label: 'Support Staff', value: 'support', description: 'Help clients and handle support tickets.' },
          { label: 'Management+', value: 'management', description: 'Lead the team and handle escalated concerns.' },
          { label: 'Design Team', value: 'design', description: 'GFX, VFX, and Discord Services.' },
        )),
    );
  } else {
    box.addTextDisplayComponents(text(
      'Welcome to **.revisonary** — your go-to destination for premium, custom-made designs that truly stand out. '
      + 'We bring a passion for creativity and a commitment to delivering top-tier results.\n\n'
      + '> **Place your order today and let us create something unforgettable.**',
    )).addSeparatorComponents(new SeparatorBuilder()).addActionRowComponents(
      new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
        .setCustomId('rv:support').setPlaceholder('Select support type.').addOptions(
          Object.entries(SUPPORT_TYPES).map(([value, option]) => ({ value, ...option })),
        )),
    );
  }
  return {
    components: [box], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] },
    files: external ? [] : [new AttachmentBuilder(fileURLToPath(new URL(`../assets/${name}`, import.meta.url)), { name })],
  };
}

export function ticketPayload(ticket) {
  const controls = ticket.closed
    ? [new ButtonBuilder().setCustomId('rv:delete').setLabel('Delete Ticket').setStyle(ButtonStyle.Danger)]
    : [new ButtonBuilder().setCustomId('rv:claim').setLabel(ticket.claimedById ? 'Claimed' : 'Claim Ticket')
      .setStyle(ButtonStyle.Primary).setDisabled(Boolean(ticket.claimedById)),
    new ButtonBuilder().setCustomId('rv:close').setLabel('Close Ticket').setStyle(ButtonStyle.Secondary)];
  const status = ticket.closed ? '**Status:** Closed — conversation saved. Staff can delete this ticket below.'
    : '**Status:** Open';
  const assigned = ticket.claimedById ? `**Claimed by:** <@${ticket.claimedById}>` : '**Claimed by:** Unclaimed';
  return {
    flags: MessageFlags.IsComponentsV2,
    files: [new AttachmentBuilder(fileURLToPath(new URL('../assets/support.png', import.meta.url)), { name: 'support.png' })],
    allowedMentions: { parse: [] },
    components: [new ContainerBuilder().addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(item => item.setURL('attachment://support.png').setDescription('.revisonary Support')),
    ).addTextDisplayComponents(
      text(`### ${SUPPORT_TYPES[ticket.type].label}`),
      text(`Welcome <@${ticket.ownerId}>. Please describe what you need help with. A member of our team will assist you here.\n\n**.revisonary** • Design that builds brands.`),
      text(`${status}\n${assigned}`),
    ).addSeparatorComponents(new SeparatorBuilder()).addActionRowComponents(
      new ActionRowBuilder().addComponents(...controls),
    )],
  };
}

export function welcomePayload(member, config) {
  return {
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [], users: [member.id] },
    components: [new ContainerBuilder()
      .addTextDisplayComponents(text(`Welcome <@${member.id}> to **.revisonary**! We hope you enjoy your stay.`))
      .addActionRowComponents(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('rv:member-count').setLabel(`Members: ${member.guild.memberCount}`)
          .setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setLabel('Dashboard').setEmoji('📋').setStyle(ButtonStyle.Link)
          .setURL(`https://discord.com/channels/${member.guild.id}/${config.dashboardChannelId}`),
      ))],
  };
}
