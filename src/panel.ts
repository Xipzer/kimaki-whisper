// Wendy's Discord control panel: one compact, self-refreshing message that shows
// everything she can see from the inside, with drill-downs behind a menu.
// Function over form; dense but never overwhelming.
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  StringSelectMenuBuilder, MessageFlags,
  type ButtonInteraction, type StringSelectMenuInteraction, type ChatInputCommandInteraction,
} from 'discord.js'
import { execFile } from 'node:child_process'
import { loadConfig } from './config.js'
import {
  wendySnapshot, wendySleep, wendyWake, wendySetDnd, wendyUnsilence, wendyIsDormant,
} from './wendy.js'
import {
  telegramPolicyStatus, telegramSentLog, telegramPrivacyStatus, telegramProfileList,
  telegramGroupsStatus, telegramPeopleStatus, telegramInbox,
} from './telegram.js'

const dot = (ok: boolean): string => (ok ? '🟢' : '🔴')
const bar = (pct: number): string => {
  const n = Math.max(0, Math.min(10, Math.round(pct / 10)))
  return '▰'.repeat(n) + '▱'.repeat(10 - n)
}

export function buildPanel(): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] } {
  const s = wendySnapshot()
  const mode = s.mode === 'ASLEEP' ? '😴 ASLEEP' : s.inVc ? '🎙️ IN VOICE' : '🟢 AWAKE'
  const flags = [
    s.dnd ? '🔕 DND' : '',
    s.silencedMin ? `🤫 silent ${s.silencedMin}m` : '',
  ].filter(Boolean).join(' · ')

  const embed = new EmbedBuilder()
    .setColor(s.mode === 'ASLEEP' ? 0x555555 : s.errors.length ? 0xe0a030 : 0x2ecc71)
    .setTitle(`Wendy — ${mode}${flags ? `  ${flags}` : ''}`)
    .setDescription(
      `${dot(s.brainUp)} brain ${s.tps ? `**${s.tps}** tok/s` : 'idle'}  ·  ctx ${bar(s.ctxPct)} **${s.ctxPct}%**  ·  memory ${s.history} msgs`,
    )
    .addFields(
      {
        name: '⚙️ Working',
        value: `self-tasks **${s.selfTasks.active}** active${s.selfTasks.done ? ` (${s.selfTasks.done} done)` : ''}\nagents **${s.spawns.filter((x) => x.status === 'running').length}** running\nwatching **${s.watching}** threads`,
        inline: true,
      },
      {
        name: '📥 Inbox',
        value: `updates **${s.updates.queued}**${s.updates.high ? ` (${s.updates.high} 🔴)` : ''}\ntelegram **${s.telegram.unread}** unread\nschedules **${s.schedules}**`,
        inline: true,
      },
      {
        name: '🗂️ Knows',
        value: `**${s.index.threads}** threads / ${s.index.projects} projects · **${s.telegram.chats}** chats · **${s.telegram.profiles}** people · index ${s.index.ageMin >= 0 ? `${s.index.ageMin}m` : 'pending'}`,
        inline: false,
      },
    )
  if (s.errors.length) {
    embed.addFields({
      name: `⚠️ Issues (${s.errors.length} in 6h)`,
      value: s.errors.slice(-3).map((e) => `\`${e.ev}\` ${e.detail.slice(0, 60) || '—'}`).join('\n') || '—',
    })
  }
  embed.setFooter({ text: `updated ${new Date().toLocaleTimeString('en-GB')}` })

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('wp:refresh').setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    wendyIsDormant()
      ? new ButtonBuilder().setCustomId('wp:wake').setLabel('Start').setEmoji('▶️').setStyle(ButtonStyle.Success)
      : new ButtonBuilder().setCustomId('wp:sleep').setLabel('Stop').setEmoji('⏸️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('wp:dnd').setLabel(s.dnd ? 'DND off' : 'DND on').setEmoji('🔕').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('wp:unsilence').setLabel('Unmute').setEmoji('🔊').setStyle(ButtonStyle.Secondary).setDisabled(!s.silencedMin),
    new ButtonBuilder().setCustomId('wp:brain').setLabel('Brain').setEmoji('🧠').setStyle(ButtonStyle.Secondary),
  )
  const menu = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId('wp:inspect').setPlaceholder('Inspect…').addOptions(
      { label: 'Tasks & agents', value: 'tasks', description: 'her own work and spawned agents', emoji: '⚙️' },
      { label: 'Telegram chats', value: 'chats', description: 'tone, privacy, autonomy per chat', emoji: '💬' },
      { label: 'Sent messages', value: 'sent', description: 'what she has sent, where, as whom', emoji: '📤' },
      { label: 'People', value: 'people', description: 'profiles and mutes', emoji: '👥' },
      { label: 'Inbox', value: 'inbox', description: 'telegram triage right now', emoji: '📥' },
      { label: 'Issues & logs', value: 'errors', description: 'errors, warnings, recent activity', emoji: '⚠️' },
    ),
  )
  return { embeds: [embed], components: [buttons, menu] }
}

/** Phone-friendly block: no code fences (they scroll sideways on mobile),
 *  every line clipped so it wraps instead of overflowing. */
function lines(text: string, max = 14, width = 58): string {
  const out = text.split('\n').filter(Boolean).slice(0, max)
    .map((l) => (l.length > width ? l.slice(0, width - 1) + '…' : l))
  return out.length ? out.map((l) => `· ${l}`).join('\n') : '· nothing yet'
}

async function detail(kind: string): Promise<string> {
  const s = wendySnapshot()
  if (kind === 'tasks') {
    const t = s.selfTasks.list.map((x) => `\`${x.status}\` ${x.goal.slice(0, 52)} · ${x.slices} slices`).join('\n') || 'no self-tasks'
    const a = s.spawns.map((x) => `\`${x.status}\` **${x.label}** (${x.ageMin}m)${x.result ? `\n   ↳ ${x.result}` : ''}`).join('\n') || 'no spawned agents'
    return `**Self-tasks**\n${t}\n\n**Spawned agents**\n${a}\n\n**Watching** ${s.watching} threads · **${s.schedules}** scheduled checks`
  }
  if (kind === 'chats') return `**Per-chat policy**\n${lines(telegramPolicyStatus(), 12)}\n\n**Privacy**\n${lines(telegramPrivacyStatus(), 6)}`
  if (kind === 'sent') return `**Recent sends**\n${lines(telegramSentLog(14), 14, 70)}`
  if (kind === 'people') return `**Profiles**\n${lines(telegramProfileList(), 12, 62)}\n\n**Muted**\n${lines(telegramPeopleStatus(), 5)}`
  if (kind === 'inbox') return `**Telegram triage (24h)**\n${lines(telegramInbox(24).replace(/\[.*?\]\n/, ''), 16, 66)}`
  if (kind === 'errors') {
    const e = s.errors.map((x) => `\`${new Date(x.at).toLocaleTimeString('en-GB')}\` **${x.ev}** ${x.detail}`).join('\n') || 'no issues in the last 6 hours ✅'
    return `**Issues (6h)**\n${e}\n\n**Groups**\n${lines(telegramGroupsStatus(), 8)}`
  }
  return 'unknown view'
}

export async function handlePanelInteraction(i: ButtonInteraction | StringSelectMenuInteraction): Promise<void> {
  const owner = loadConfig().ownerId
  if (owner && i.user.id !== owner) {
    await i.reply({ content: 'Wendy only answers to her owner.', flags: MessageFlags.Ephemeral }).catch(() => {})
    return
  }
  const id = i.customId
  if (i.isStringSelectMenu() && id === 'wp:inspect') {
    const body = await detail(i.values[0])
    await i.reply({ content: body.slice(0, 1900), flags: MessageFlags.Ephemeral }).catch(() => {})
    return
  }
  if (!i.isButton()) return
  let note = ''
  if (id === 'wp:sleep') note = wendySleep()
  else if (id === 'wp:wake') note = wendyWake()
  else if (id === 'wp:dnd') note = wendySetDnd(!wendySnapshot().dnd)
  else if (id === 'wp:unsilence') note = wendyUnsilence()
  else if (id === 'wp:brain') {
    const wake = loadConfig().brainWakeCommand
    const stop = (wake ?? '').replace(/start\s+\w+/, 'stop')
    if (wake && stop !== wake) {
      execFile('bash', ['-c', `${stop} ; sleep 3 ; ${wake}`], { timeout: 180000, killSignal: 'SIGKILL' }, () => {})
      note = 'brain restarting (~40s)'
    } else note = 'no brain command configured'
  }
  await i.update(buildPanel()).catch(() => {})
  if (note) await i.followUp({ content: note.slice(0, 300), flags: MessageFlags.Ephemeral }).catch(() => {})
}

export async function sendPanel(i: ChatInputCommandInteraction): Promise<void> {
  const owner = loadConfig().ownerId
  if (owner && i.user.id !== owner) {
    await i.reply({ content: 'Wendy only answers to her owner.', flags: MessageFlags.Ephemeral }).catch(() => {})
    return
  }
  await i.reply({ ...buildPanel(), flags: MessageFlags.Ephemeral }).catch(() => {})
}
