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
  const external = kind === 'verification' ? config.verificationBannerUrl : config.dashboardBannerUrl;
  const name = `${kind}.png`;
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
  return {
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
    components: [new ContainerBuilder().addTextDisplayComponents(
      text(`### ${SUPPORT_TYPES[ticket.type].label}`),
      text(`Welcome <@${ticket.ownerId}>. Please describe what you need help with. A member of our team will assist you here.\n\n**.revisonary** • Design that builds brands.`),
    ).addSeparatorComponents(new SeparatorBuilder()).addActionRowComponents(
      new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setCustomId('rv:close').setLabel('Close Ticket').setStyle(ButtonStyle.Secondary)),
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
