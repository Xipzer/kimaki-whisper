// Tool schemas exposed to the brain. Pure data - execution lives in wendy.ts
// (to be split into per-domain executors). Keep descriptions terse: every
// character here is re-processed on each cache miss.
export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_projects',
      description: 'List the Kimaki project channels (the agent organisation chart).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dispatch_task',
      description:
        'Send a task to a project channel as a new agent session (a new Discord thread). Returns immediately; the agent works asynchronously.',
      parameters: {
        type: 'object',
        properties: {
          channel_id: { type: 'string', description: 'Target project channel id from list_projects' },
          prompt: { type: 'string', description: 'The task, written as a complete instruction for the agent' },
        },
        required: ['channel_id', 'prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_recent_sessions',
      description: 'List recent agent sessions (threads) for a project directory, newest first.',
      parameters: {
        type: 'object',
        properties: {
          directory: { type: 'string', description: 'Project directory path from list_projects' },
        },
        required: ['directory'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lookup_thread',
      description: 'INSTANT lookup in the auto-maintained index of ALL threads across ALL projects. Always try this BEFORE search_sessions.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'topic keywords, e.g. "basestonk launchpad"' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'watch_thread',
      description: 'Passively watch a session; when the agent replies, the owner is notified aloud automatically (or on next join).',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          label: { type: 'string', description: 'short spoken name, e.g. "nutrition"' },
        },
        required: ['session_id', 'label'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_sessions',
      description: 'Search all past agent sessions by topic/keyword to find the right existing thread.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Topic or keywords, e.g. "nutrition", "benchmark"' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_thread',
      description:
        'Proxy a question/instruction INTO an existing agent session and WAIT for its reply (up to ~2 min). Use for anything the owner wants from an existing thread. Returns the agent\'s response.',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Session id (ses_...) from routes or search' },
          prompt: { type: 'string', description: 'The owner\'s request, phrased for that agent' },
        },
        required: ['session_id', 'prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_to_session',
      description:
        'Fire-and-forget: send a task into an existing agent session without waiting. Use for long work; tell the owner you\'ll report back.',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          prompt: { type: 'string' },
        },
        required: ['session_id', 'prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_session',
      description: 'Read the tail of an agent session\'s conversation - use to report results or catch up on what happened.',
      parameters: {
        type: 'object',
        properties: {
          chars: { type: 'number', description: 'Omit for the default: the last few messages, aggregated and cleaned. Set a value (up to 30000) to read that much raw recent transcript when you need to dig deeper into history.' }, session_id: { type: 'string' } },
        required: ['session_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Run a shell command on the host (your own workspace is the cwd; curl, python3, standard tools available). For quick lookups, calculations, file ops, checking things. Output is truncated for speech - summarise aloud. SPEED MATTERS, he is waiting: never scan the whole filesystem (no "find /" - it burns the timeout and makes you look frozen), search specific project directories instead, cap output with head, and prefer one targeted command over several broad ones.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeout_sec: { type: 'number', description: 'default 60' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_note',
      description:
        'Write/append a note file in your workspace (scratchpad, todo lists, standing memory in memory.md, disposable thinking files).',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'e.g. memory.md, todo.md, thinking/plan.md' },
          content: { type: 'string' },
          append: { type: 'boolean', description: 'default false (overwrite)' },
        },
        required: ['filename', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_note',
      description: 'Read a note file from your workspace. Read memory.md when the owner references standing preferences/facts.',
      parameters: {
        type: 'object',
        properties: { filename: { type: 'string' } },
        required: ['filename'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_route',
      description: 'Remember a destination permanently: name → session/thread/channel. Use whenever the owner names a recurring topic.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short alias, e.g. "nutrition"' },
          id: { type: 'string', description: 'ses_… / thread id / channel id' },
          kind: { type: 'string', enum: ['session', 'thread', 'channel'] },
          note: { type: 'string', description: 'What lives there' },
          tier: { type: 'string', enum: ['interrupt', 'digest', 'onjoin'], description: 'Notification priority for this route (default digest)' },
        },
        required: ['name', 'id', 'kind', 'note'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_reply',
      description: 'Get the LATEST reply (last assistant message) from a thread, near-verbatim. THE tool for "what did it reply / what did it say / fetch the response". Copy the ses_ id exactly from a lookup result in this same turn - never from memory.',
      parameters: {
        type: 'object',
        properties: { session_id: { type: 'string', description: 'ses_… - copy exactly from lookup_thread output' } },
        required: ['session_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'spawn_agent',
      description: 'Spawn a full agent (opencode, local model) in the #wendy Discord channel where the owner can read and reply. For delegating substantial subtasks. Concurrency-capped: check spawns_status first; collect finished work before spawning more. Every spawn is ledgered and auto-watched - results arrive as updates.',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'Complete self-contained task for the agent' },
          label: { type: 'string', description: 'Short spoken name for this agent, e.g. "repo scanner"' },
          model: { type: 'string', enum: ['local', 'opus', 'fable'], description: 'local = your own LLM (default; shares YOUR compute - conversation may slow while it works), opus = strongest cloud model, fable = fast cloud model' },
        },
        required: ['goal'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'switch_thread_model',
      description: 'Switch an existing thread to a different model on the fly - e.g. move a thread OFF your own LLM (local) onto opus to free up your compute when you are slowing down or expect load. Upgrades only: moving a thread to a WEAKER model (e.g. opus -> local) is blocked unless the owner asks for it himself - never use it to get past a content-filter block. Only local, opus, or fable exist; NOTHING else is permitted (other local models would kill your own brain - fragile).',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'ses_... to switch' },
          model: { type: 'string', enum: ['local', 'opus', 'fable'] },
        },
        required: ['session_id', 'model'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'spawns_status',
      description: 'Your spawn ledger: every agent you have spawned - running/done/stale, ages, results. THE authoritative record; check it before spawning more.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'self_task',
      description: 'Queue a long-running task for YOURSELF (not a thread): multi-repo analysis, deep research across the organisation, anything needing your own sustained tool work. You will work it autonomously in background slices between conversation and announce the result when done. Accept, confirm briefly, move on - never attempt long work in-turn.',
      parameters: {
        type: 'object',
        properties: { goal: { type: 'string', description: 'Complete, self-contained description of the task and what the result should contain' } },
        required: ['goal'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'self_tasks_status',
      description: 'List your background self-tasks: goals, progress (slices worked), status, results.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'thread_health',
      description: 'Deterministic status of a thread from the OpenCode database: BLOCKED (content filter - invisible in read_session tails), ERRORED (last turn failed, with the error), WORKING, WAITING (prompt sent, no reply), ABORTED or IDLE; plus last activity, model and context size. Use this instead of guessing from a transcript.',
      parameters: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'guard_thread',
      description: 'Auto-unblock a thread: from now on every content-filter block on it is pushed past automatically within ~20 s, forever, without being asked again (neutral rephrase -> abstract design note -> smaller parts; never changes its model). Use when the owner asks you to tail/babysit/keep unblocking a thread. on:false stops it. Your own spawned agents are guarded automatically.',
      parameters: { type: 'object', properties: { session_id: { type: 'string' }, on: { type: 'boolean', description: 'false to stop guarding' } }, required: ['session_id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'commitments',
      description: 'List the promises you have made that are still open (tracked automatically from what you say, e.g. "I\'ll tell you when the table lands"). Each fires a COMMITMENT DUE turn when its thread moves or its time comes - even while the owner is away.',
      parameters: { type: 'object', properties: { drop_id: { type: 'string', description: 'optional: id of a commitment to drop because it no longer applies' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'autonomy_rules',
      description: 'View or set what needs the owner\'s OK before you do it while he is away. Default: nothing - you act with his full authority using every tool you have. Only change when HE asks.',
      parameters: { type: 'object', properties: { ask_first: { type: 'array', items: { type: 'string' }, description: 'kinds of action that need his OK first, in plain words (e.g. "sending Telegram messages", "deploys"). Omit to just view.' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_check',
      description: 'Set a future follow-up: in N minutes, either re-check a session (reads it fresh and reports its state) or deliver a plain reminder. Survives restarts; delivered at a natural conversation pause. Use when the owner says "remind me" / "check on it later", and proactively as a safety net after dispatching long work the owner cares about.',
      parameters: {
        type: 'object',
        properties: {
          minutes: { type: 'number', description: 'How many minutes from now (1-1440)' },
          note: { type: 'string', description: 'What this is about, in owner-friendly words' },
          session_id: { type: 'string', description: 'ses_… to re-check at that time (omit for a plain reminder)' },
        },
        required: ['minutes', 'note'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall',
      description: 'Search your long-term journal of past conversations ("do you remember when...", "what did I say about..."). Returns dated episodes. Your standing memory and possibly-relevant moments are already in context - use recall for deeper or more specific digging.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'what to search for' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'telegram_inbox',
      description: 'The owner\'s Telegram DM triage: VIP messages, known contacts, and a spam-collapsed digest of everything else. Read-only. Use when the owner asks about Telegram, their DMs, or "anything important come in?".',
      parameters: {
        type: 'object',
        properties: { hours: { type: 'number', description: 'lookback window, default 24' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'telegram_reply',
      description: 'Reply to the conversation you are currently handling - the exact chat the message you are answering came from. ALWAYS use this when responding to an incoming message; it cannot go to the wrong room. Only use telegram_send when starting a conversation somewhere else.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'message body, HTML formatting allowed' },
          quote: { type: 'boolean', description: 'default true - replies directly to the message you are answering, so it threads in Telegram. false sends a standalone message to the same chat.' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'telegram_send',
      description: 'Start or continue a Telegram conversation. Targeting a PERSON while a group conversation is live routes to that group automatically (reply where the conversation is happening) - prefix with "dm:" when you genuinely mean a private message. Prefer telegram_reply when answering an incoming message. DMs go out AS HIM (business connection); groups go out as the bot. Supports HTML formatting: <b>bold</b> <i>italic</i> <u>underline</u> <s>strike</s> <code>mono</code> <pre>block</pre> <a href="url">link</a> <tg-spoiler>spoiler</tg-spoiler> <blockquote>quote</blockquote>. Compose the exact text the owner asked for, formatted well. If his intent is ambiguous, confirm the wording first - once sent it cannot be unsent.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'group name fragment, contact name, or numeric chat id' },
          text: { type: 'string', description: 'message body with HTML formatting' },
        },
        required: ['target', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'telegram_grant',
      description: 'Record the owner granting (or revoking) autonomous replies in ONE chat: "you can reply to the next 5 messages from X". Also sets tone. Call this when he grants permission - never grant yourself. Set count 0 to revoke.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'chat name fragment, contact name, or id' },
          count: { type: 'number', description: 'how many autonomous replies he authorised. 0 revokes. -1 = INDEFINITE (no counter, no expiry) - only when he clearly says something like "just reply to them from now on".' },
          tone: { type: 'string', enum: ['professional', 'casual', 'banter'] },
          scope: { type: 'string', description: 'what the conversation is about, in a few words' },
          hours: { type: 'number', description: 'how long the grant stays valid, default 12 (ignored for indefinite)' },
          person: { type: 'string', description: 'optional: restrict autonomy to ONE person in that chat (their @handle or name)' },
        },
        required: ['target', 'count'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'telegram_tone',
      description: 'Set the conversational register for a chat WITHOUT granting autonomy: professional (default - measured, courteous), casual (relaxed, friendly), banter (the boys - trolling and profanity are welcome). Use when the owner tells you what a chat is like, or when you infer it and he confirms.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string' },
          tone: { type: 'string', enum: ['professional', 'casual', 'banter'] },
        },
        required: ['target', 'tone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'telegram_policy',
      description: 'Your standing in every chat: tone register, remaining autonomous replies, time left. Check before replying autonomously or when unsure whether you need permission.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'owner_autonomy',
      description: 'Control whether you may answer XIPZ HIMSELF in Telegram, and how strictly. Modes: enforced (default - he must @tag you), relaxed (saying your name is enough), off (never reply to him unprompted). Scope: one chat, or global which overrides every chat until cleared (chat settings are kept and resume). Use scope "clear-global" to lift the override. Only he can change this.',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['chat', 'global', 'clear-global'] },
          mode: { type: 'string', enum: ['off', 'enforced', 'relaxed'] },
          target: { type: 'string', description: 'chat name (required when scope is chat)' },
        },
        required: ['scope'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'owner_autonomy_status',
      description: 'Show owner-autonomy settings: the global override if active, and any per-chat settings.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'telegram_privacy',
      description: 'Control what you may SAY ALOUD about a chat: open (normal summaries), discreet (name who messaged and that it matters, never the topic or content), silent (say nothing at all until he asks). Use when he says things like "don\'t read that one out loud" or "keep that chat vague".',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string' },
          level: { type: 'string', enum: ['open', 'discreet', 'silent'] },
        },
        required: ['target', 'level'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'privacy_mode',
      description: 'Global discretion switch for when he is on speaker or has company: while ON, EVERY Telegram chat is treated as discreet - you name who and that it matters, never the content. Turn on when he says "I\'m on speaker", "people are around", "keep it vague"; off when he says he is alone again. Pass on:false to check nothing - use telegram_privacy_status to read state.',
      parameters: { type: 'object', properties: { on: { type: 'boolean' } }, required: ['on'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'telegram_privacy_status',
      description: 'Current discretion settings: the global switch plus any per-chat overrides.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'telegram_watch',
      description: 'Control how a Telegram chat surfaces to you: immediate (every message), threshold (summarise once N messages build up - the default, N configurable), ignore (mute entirely). Use when the owner says things like "only tell me about that group if it really kicks off" or "ignore that chat".',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string' },
          mode: { type: 'string', enum: ['immediate', 'threshold', 'ignore'] },
          threshold: { type: 'number', description: 'messages required before you summarise (threshold mode)' },
        },
        required: ['target', 'mode'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'person_profile',
      description: 'Your cross-chat working knowledge of someone: how they talk, what they usually want, history, and how to tell when they are being serious. Check before replying to someone you know - it saves rebuilding context. Omit name to list everyone you know.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'person_tone',
      description: 'Set how you talk to a PERSON wherever you meet them (professional/casual/banter) - a mate you banter with in one group stays a mate in another. Chat-level tone set explicitly by the owner still overrides this.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' }, tone: { type: 'string', enum: ['professional', 'casual', 'banter'] } },
        required: ['name', 'tone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'person_note',
      description: 'Add something durable to your profile of a person (a preference, a fact, a boundary, a running joke). Use when you learn something about them worth remembering across chats.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' }, note: { type: 'string' } },
        required: ['name', 'note'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'telegram_mute_person',
      description: 'Stop surfacing updates about ONE person: "I don\'t want to hear about X" (no count = indefinite) or "for the next 20 messages" (count). Pass 0 to unmute. You still handle their messages yourself and still hand the owner a catch-up summary every 10 exchanges he has not seen.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'person name or @handle' },
          count: { type: 'number', description: 'mute for this many of their messages; omit for indefinite; 0 unmutes' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'telegram_chat',
      description: 'Read a chat\'s recent messages (read-only, repeatable - reading never consumes them). Use when the owner asks about a chat, or before replying so you know what was actually said.',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string' },
          count: { type: 'number', description: 'how many recent messages, default 25, up to 300 when reaching into the archive' },
          hours: { type: 'number', description: 'look back this many hours (reads the full archive, not just recent memory)' },
          all: { type: 'boolean', description: 'true = full recent history including what you already reported (for when he asks you to re-read or go back); default false = only what is new since your last update' },
        },
        required: ['target'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'telegram_sent',
      description: 'Your record of messages you have actually sent: when, to which chat, as whom, and the text. Use this the moment the owner asks "who did you send that to" or "did that go through" - never answer those from memory.',
      parameters: { type: 'object', properties: { limit: { type: 'number' } }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'telegram_members',
      description: 'Who is known to be in a chat (everyone who has spoken there). Check this before sending to a chat you are not certain about - sends that tag someone absent from the target chat are BLOCKED automatically, but checking first is faster.',
      parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'telegram_search',
      description: 'Search everything ever ingested from Telegram - every chat, every person, back to the start of the archive. Use for "what did X say about Y", "when did we discuss Z", or anything older than the recent conversation. Optionally narrow by chat and/or sender.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'words that must all appear' },
          chat: { type: 'string', description: 'optional: restrict to one chat' },
          from: { type: 'string', description: 'optional: restrict to one sender (name or @handle)' },
          limit: { type: 'number', description: 'max results, default 12' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'telegram_who',
      description: 'Look up a person\'s real @handle before tagging them - checks everyone who has messaged plus live chat-admin rosters. NEVER guess a handle: if this returns nothing, say you do not have it and ask the owner.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'display name or partial handle' },
          chat: { type: 'string', description: 'optional chat to search' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'telegram_groups',
      description: 'Manage Telegram group ingestion yourself: list shows every group the bot is in and whether it is ingesting; mute/unmute toggles a group by name or id. Groups ingest automatically when the owner adds the bot - mute is the exception, not the rule.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'mute', 'unmute'] },
          group: { type: 'string', description: 'group name fragment or id (for mute/unmute)' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'brain_health',
      description: 'Measure your own reasoning speed right now: runs a timed probe and reports tokens/sec with a verdict (full speed / degraded / likely spilled into system memory). Use when the owner asks if you are slow, laggy, or overflowing.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'index_pulse',
      description: 'Ambient view of the whole organisation: which threads are active RIGHT NOW, which worked recently, which went quiet mid-task. THE tool for broad questions like "what is going on", "anything stuck", "how are things looking".',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'index_stats',
      description: 'Exact stats of your thread index: total threads, projects, last refresh. ALWAYS use this when asked how many threads/projects you know - never estimate from lookup results.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'say',
      description: 'Speak a short sentence to the owner RIGHT NOW while you keep working ("one sec, checking that thread"). Use this whenever a task needs multiple steps so the owner is never left in silence. After say, CONTINUE with your tools - your final answer comes at the end.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '1-2 short spoken sentences' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'nickname_thread',
      description: 'Give a thread a short spoken nickname (your own memory - does not rename the real thread). Use at your discretion whenever a title is long or awkward to say; use the nickname consistently afterwards. Owner can assign or change nicknames too.',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'ses_… id' },
          nickname: { type: 'string', description: 'Short natural spoken name, e.g. "the launcher thread"' },
        },
        required: ['session_id', 'nickname'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_dnd',
      description: 'Toggle do-not-disturb for updates: while on, you never offer or mention updates (they quietly accumulate) - the only exception is an automatic nudge when 3+ high-priority items stack. ONLY on the owner\'s explicit request; never suggest it, never activate it yourself. Different from go_silent: you still converse normally under DND.',
      parameters: {
        type: 'object',
        properties: { on: { type: 'boolean' } },
        required: ['on'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'snooze_updates',
      description: 'Stop offering updates for a while (they keep accumulating). Call when the owner genuinely dismisses updates - "not now", "later", "stop asking". Pass minutes: 0 to CANCEL an active snooze and restore normal flow.',
      parameters: {
        type: 'object',
        properties: { minutes: { type: 'number', description: '0 cancels; default 30' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'go_silent',
      description: 'Silence yourself completely for N minutes: no speaking, no announcements, incoming speech is discarded before reaching your reasoning. ONLY call this when the owner explicitly asks you to be quiet/silent/muted. NEVER activate it on your own judgment and NEVER suggest or offer it. The owner can end it early just by saying your name.',
      parameters: {
        type: 'object',
        properties: {
          minutes: { type: 'number', description: 'Duration in minutes (default 30, max 480)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_notify_tier',
      description: 'Set notification priority for a saved route: interrupt = speak immediately, digest = batched every few minutes, onjoin = only when owner joins voice.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Existing route alias' },
          tier: { type: 'string', enum: ['interrupt', 'digest', 'onjoin'] },
        },
        required: ['name', 'tier'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'thread_model_pin',
      description: 'PIN a thread to a model: re-asserts it within seconds whenever anything resets it, telling the owner each time. Use when he says a thread keeps falling back to the global default. model: "current" (keep what the thread has NOW - the usual case when he says "keep it on X"), a full id like anthropic/claude-fable-5-1, or an alias (local/opus/fable). A pin that would CHANGE the model is refused unless confirm_change is true.',
      parameters: { type: 'object', properties: { session_id: { type: 'string' }, model: { type: 'string', description: '"current" | full provider/model id | alias' }, confirm_change: { type: 'boolean', description: 'true only when the owner explicitly wants a DIFFERENT model than the thread has now' } }, required: ['session_id', 'model'] },
    },
  },
  { type: 'function', function: { name: 'thread_model_unpin', description: 'Remove a model pin from a thread.', parameters: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'] } } },
  { type: 'function', function: { name: 'thread_model_pins', description: 'List active model pins and how often each has had to be re-asserted.', parameters: { type: 'object', properties: {} } } },
  {
    type: 'function',
    function: {
      name: 'thread_trigger',
      description: 'Watch a thread for a PATTERN in its new content and fire an ACTION the moment it appears (checked every 45s): ping = tell the owner; send = send a counter-message into the thread (with prompt); both. This is the general "when X happens in that thread, do Y" tool.',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          pattern: { type: 'string', description: 'regex (case-insensitive) matched against new thread content' },
          action: { type: 'string', description: 'ping | send | both' },
          prompt: { type: 'string', description: 'message to send into the thread when it fires (send/both)' },
          label: { type: 'string', description: 'short human name for this trigger' },
          once: { type: 'boolean', description: 'disarm after the first fire' },
        },
        required: ['session_id', 'pattern', 'action'],
      },
    },
  },
  { type: 'function', function: { name: 'thread_triggers', description: 'List armed triggers and fire counts.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'thread_trigger_remove', description: 'Disarm a trigger by id.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
  {
    type: 'function',
    function: {
      name: 'name_only_mode',
      description: 'For calls with other people in them: ON = ignore everything the owner says unless he addresses you by name ("Wendy, ..."), while still delivering updates at pauses and never barging in. OFF = normal. Only on his explicit request ("name only", "only listen when I say your name", "I have someone in the call").',
      parameters: { type: 'object', properties: { on: { type: 'boolean' } }, required: ['on'] },
    },
  },
] as const
