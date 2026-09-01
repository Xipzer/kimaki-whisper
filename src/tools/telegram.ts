// Telegram tool executors. Pure delegation to telegram.ts - no access to
// voice/thread state by design (verified: zero wendy.ts dependencies).
import { telegramInbox, telegramGroupsStatus, telegramGroupSetMuted, telegramSend, telegramGrant, telegramSetTone, telegramPolicyStatus, telegramWatchMode, telegramChatDigest, telegramWho, telegramRoster, telegramMutePerson, telegramProfile, telegramProfileList, telegramProfileNote, telegramChatMembers, telegramSetPrivacy, telegramPrivacyMode, telegramPrivacyStatus, telegramSetPersonTone, telegramSentLog, setOwnerAutonomy, ownerAutonomyStatus, telegramReplyHere, telegramSearch } from '../telegram.js'

/** Returns undefined when the tool is not a Telegram tool. */
export async function executeTelegramTool(name: string, args: Record<string, unknown>): Promise<string | undefined> {
  if (name === 'telegram_reply') {
    return telegramReplyHere(String(args.text ?? ''), args.quote === undefined ? true : Boolean(args.quote))
  }
  if (name === 'telegram_send') {
    return telegramSend(String(args.target ?? ''), String(args.text ?? ''))
  }
  if (name === 'owner_autonomy') {
    return setOwnerAutonomy(String(args.scope ?? 'chat'), String(args.mode ?? 'enforced'), args.target as string | undefined)
  }
  if (name === 'owner_autonomy_status') {
    return ownerAutonomyStatus()
  }
  if (name === 'telegram_privacy') {
    return telegramSetPrivacy(String(args.target ?? ''), String(args.level ?? 'open'))
  }
  if (name === 'privacy_mode') {
    return telegramPrivacyMode(Boolean(args.on))
  }
  if (name === 'telegram_privacy_status') {
    return telegramPrivacyStatus()
  }
  if (name === 'telegram_watch') {
    return telegramWatchMode(String(args.target ?? ''), String(args.mode ?? 'threshold'), Number(args.threshold) || undefined)
  }
  if (name === 'person_profile') {
    const n = String(args.name ?? '').trim()
    if (!n) return telegramProfileList()
    return telegramProfile(n) || `no profile for "${n}" yet`
  }
  if (name === 'person_tone') {
    return telegramSetPersonTone(String(args.name ?? ''), String(args.tone ?? 'professional'))
  }
  if (name === 'person_note') {
    return telegramProfileNote(String(args.name ?? ''), String(args.note ?? ''))
  }
  if (name === 'telegram_mute_person') {
    return telegramMutePerson(String(args.name ?? ''), args.count === undefined ? undefined : Number(args.count))
  }
  if (name === 'telegram_chat') {
    return telegramChatDigest(String(args.target ?? ''), Math.min(Math.max(Number(args.count) || 25, 5), 300), Boolean(args.all) || !!args.hours, Number(args.hours) || undefined)
  }
  if (name === 'telegram_sent') {
    return telegramSentLog(Math.min(Math.max(Number(args.limit) || 12, 1), 50))
  }
  if (name === 'telegram_members') {
    return telegramChatMembers(String(args.target ?? ''))
  }
  if (name === 'telegram_search') {
    return telegramSearch(String(args.query ?? ''), { chat: args.chat as string | undefined, from: args.from as string | undefined, limit: Number(args.limit) || undefined })
  }
  if (name === 'telegram_who') {
    const direct = await telegramWho(String(args.name ?? ''), args.chat as string | undefined)
    return direct.startsWith('no handle') ? `${direct}\n\nHandles currently on record:\n${telegramRoster().slice(0, 600)}` : direct
  }
  if (name === 'telegram_grant') {
    return telegramGrant(String(args.target ?? ''), Number(args.count ?? 0), args.tone as string | undefined, args.scope as string | undefined, Number(args.hours) || 12, args.person as string | undefined)
  }
  if (name === 'telegram_tone') {
    return telegramSetTone(String(args.target ?? ''), String(args.tone ?? 'professional'))
  }
  if (name === 'telegram_policy') {
    return telegramPolicyStatus()
  }
  if (name === 'telegram_groups') {
    const action = String(args.action ?? 'list')
    if (action === 'list') return telegramGroupsStatus()
    return telegramGroupSetMuted(String(args.group ?? ''), action === 'mute')
  }
  if (name === 'telegram_inbox') {
    return telegramInbox(Math.min(Math.max(Number(args.hours) || 24, 1), 168))
  }
  return undefined
}
