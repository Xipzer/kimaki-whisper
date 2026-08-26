# Wendy - Architecture Overview

*A local-first, voice-native AI chief of staff. Runs entirely on consumer hardware.
Zero API costs for her core loop. This document is a capability overview - the
interesting engineering lives in the details, and the details stay home.*

---

## What she is

Wendy is a persistent voice presence in Discord. She follows her owner into any
voice channel, holds fluid natural conversation, and operates a large
organisation of AI agent threads on their behalf - reading them, tasking them,
watching them, and reporting back at conversationally appropriate moments.

She is not a chatbot with a microphone. She is an always-on system with ears, a
voice, memory, ambient awareness of everything her owner's agents are doing, and
her own background workforce.

## The stack, from the top

```
                                 ┌──────────────────────────┐
                                 │        THE OWNER          │
                                 │   (Discord voice channel) │
                                 └────────────┬─────────────┘
                                       voice  │  presence
                                              ▼
     ┌────────────────────────────────────────────────────────────────┐
     │                     CONVERSATION LAYER                          │
     │  local speech-to-text ──► turn engine ──► local text-to-speech  │
     │                                                                 │
     │  · human turn-taking: she waits for your gap, yields when       │
     │    interrupted, resumes when the interruption was a phantom     │
     │  · interruption reasoning: answers you first, then decides      │
     │    whether her unfinished thought still deserves finishing      │
     │  · multi-layer phantom defense: energy, confidence, artifact    │
     │    and context filters - self-calibrating to the owner's voice  │
     │  · wake word, timed silence, do-not-disturb - all owner-only    │
     └───────────────────────────────┬────────────────────────────────┘
                                     │
                                     ▼
     ┌────────────────────────────────────────────────────────────────┐
     │                      COGNITION LAYER                            │
     │        local LLM (single GPU) - streaming, tool-calling         │
     │                                                                 │
     │  · a persona composed from the great fictional assistants:      │
     │    composure, operational tempo, owner-calibrated warmth,       │
     │    pure execution when work is work                             │
     │  · ~20 tools: thread lookup/reading/dispatch, notes, memory     │
     │    recall, scheduling, self-tasks, agent spawning, health       │
     │  · error self-awareness: failures are spoken, remembered, and   │
     │    never glossed over                                           │
     └───────┬──────────────────────┬─────────────────────┬───────────┘
             │                      │                     │
             ▼                      ▼                     ▼
   ┌───────────────────┐  ┌──────────────────┐  ┌─────────────────────┐
   │   MEMORY SYSTEM    │  │ AMBIENT AWARENESS │  │    ORCHESTRATION     │
   │                    │  │                   │  │                      │
   │ three tiers:       │  │ a live index of   │  │ · background self-  │
   │ · working history  │  │ every agent       │  │   tasks: her own    │
   │ · episodic journal │  │ thread across     │  │   long-running work,│
   │   (auto-compressed │  │ every project     │  │   advanced between  │
   │   from evicted     │  │                   │  │   conversation,     │
   │   conversation)    │  │ · change feed     │  │   foreground always │
   │ · consolidated     │  │ · stall detection │  │   wins              │
   │   standing memory  │  │ · git activity    │  │ · spawned agents:   │
   │   (rewritten, not  │  │ · cached          │  │   full coding       │
   │   appended)        │  │   briefings for   │  │   agents in a       │
   │                    │  │   instant status  │  │   dedicated channel │
   │ retrieval is       │  │   answers         │  │   the owner can     │
   │ relevance-gated:   │  │                   │  │   read and join     │
   │ zero context cost  │  │ everything        │  │ · a persistent      │
   │ until a memory     │  │ prioritised, de-  │  │   ledger: no agent  │
   │ actually matters   │  │ duplicated, and   │  │   is ever lost      │
   │                    │  │ staleness-checked │  │ · load-aware model  │
   │                    │  │ before speaking   │  │   selection between │
   │                    │  │                   │  │   local and cloud   │
   └───────────────────┘  └──────────────────┘  └─────────────────────┘
             │                      │                     │
             └──────────────────────┼─────────────────────┘
                                    ▼
     ┌────────────────────────────────────────────────────────────────┐
     │                    THE AGENT ORGANISATION                       │
     │   dozens of projects, hundreds of long-running agent threads    │
     │   (coding, research, health tracking, finance - anything)       │
     │                                                                 │
     │   Wendy reads them passively, tasks them explicitly, watches    │
     │   what she dispatches, and weaves results back into voice       │
     │   conversation at natural pauses - with consent, priorities,    │
     │   and a do-not-disturb mode with a high-priority pressure valve │
     └────────────────────────────────────────────────────────────────┘
```

## Design principles

**Assistant first.** Her primary objective function is being a fluid,
human-like conversational presence. The technical reach is an enhancement, not
the identity. Every behavior flows from "what would a great human assistant do
here" - never from "what would a notification system do."

**The owner's attention is the protected resource.** Updates ask before they
speak. Priorities gate what interrupts. Dismissals are honored instantly.
Nothing is ever dumped.

**Foreground always wins.** Background work - her own tasks, spawned agents,
consolidation - yields to live conversation instantly, mid-computation if
necessary.

**Route work, read facts.** Facts already on record are read passively; agent
threads are only occupied when something actually needs doing or reasoning.

**Memory without weight.** Conversation is compressed into episodes as it ages;
episodes consolidate into standing memory on a sleep-like cycle; retrieval is
relevance-gated so remembering costs nothing until a memory is actually useful.

**Trust through honesty.** Errors are announced, not hidden. Stale information
is re-verified before it is spoken. Coverage limits are stated. Every internal
decision is diagnosable from a structured event stream.

**Local by default.** Speech recognition, synthesis, and cognition run on hardware
in the house. The core loop costs nothing per token and shares nothing with
anyone.

## Reliability

Supervised process lifecycle, persistent state across restarts (moods, modes,
memory, schedules, ledgers), watchdogs on every pipeline stage, automatic brain
wake-up, self-calibrating audio gates, and a full structured diagnostics stream
that makes every conversation replayable for tuning.

## What this document doesn't tell you

The prompts, the thresholds, the scoring functions, the consolidation cycles,
the delivery heuristics, and roughly two hundred fixes' worth of hard-won edge
cases. That's the cookie. This was the bite.
