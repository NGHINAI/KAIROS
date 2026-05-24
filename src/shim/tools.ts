// MCP tool definitions for KAIROS.
// These are the 7 tools Claude Code sees when the KAIROS MCP server is active.

export const TOOL_DEFINITIONS = [
  {
    name: 'kairos_assign',
    description:
      'Assign a task to KAIROS for autonomous execution. KAIROS will work on it in the background, surfacing results via kairos_inbox and notifying you when done or blocked. Use for work that should continue independently.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        description: {
          type: 'string',
          description: 'What you want KAIROS to do. Be specific.',
        },
        working_dir: {
          type: 'string',
          description:
            'Absolute path to the working directory. Defaults to current cwd.',
        },
        priority: {
          type: 'string',
          enum: ['low', 'normal', 'high', 'urgent'],
          default: 'normal',
        },
        permission_mode: {
          type: 'string',
          enum: ['auto', 'bypass', 'trusted'],
          default: 'auto',
          description:
            "auto = ML-based approval. bypass = allow non-protected ops. trusted = --dangerously-skip-permissions. Protected ops (git push, npm publish) always need kairos_approve regardless.",
        },
        watch: {
          type: 'boolean',
          default: false,
          description: 'If true, re-checks periodically (watching task).',
        },
        tick_interval_sec: {
          type: 'number',
          description: 'For watch tasks: how often to re-check (default 300).',
        },
      },
      required: ['description'],
    },
  },
  {
    name: 'kairos_tell',
    description:
      'Send a direct message to KAIROS. Like chatting — KAIROS will respond on its next tick. Use for quick questions or instructions that are not full tasks.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        message: {
          type: 'string',
          description: 'The message to send to KAIROS.',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'kairos_status',
    description:
      'Get a snapshot of what KAIROS is doing right now: running tasks, tick state, pending approvals, connected sessions.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'kairos_inbox',
    description:
      'Read pending proactive messages from KAIROS (task completions, blockers, approvals, observations). Messages marked read after this call unless peek:true.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        peek: {
          type: 'boolean',
          default: false,
          description: 'If true, read without marking as read.',
        },
      },
    },
  },
  {
    name: 'kairos_approve',
    description:
      'Approve or deny a pending permission request from KAIROS. Use when KAIROS surfaces a blocked command (git push, npm publish, etc.).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        approval_id: {
          type: 'string',
          description: 'The approval ID from the inbox notification.',
        },
        decision: {
          type: 'string',
          enum: ['approve', 'deny', 'approve_task_scope'],
          description:
            "approve = one-time allow. deny = block. approve_task_scope = allow this pattern for the current task.",
        },
        reason: {
          type: 'string',
          description: 'Optional reason (useful for deny).',
        },
      },
      required: ['approval_id', 'decision'],
    },
  },
  {
    name: 'kairos_tasks',
    description:
      'List tasks KAIROS knows about, with optional filtering. Pass task_id for full details of a single task.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: {
          type: 'string',
          enum: [
            'all',
            'pending',
            'running',
            'done',
            'failed',
            'cancelled',
            'blocked',
          ],
          default: 'all',
        },
        limit: { type: 'number', default: 20 },
        task_id: {
          type: 'string',
          description:
            'If provided, returns full details for this task instead of the list.',
        },
      },
    },
  },
  {
    name: 'kairos_history',
    description:
      'Debug/observability: recent tick decisions — what KAIROS thought at each wake-up and what it decided.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', default: 20 },
      },
    },
  },
  {
    name: 'kairos_schedule',
    description:
      'Create, list, or delete scheduled tasks. KAIROS fires them on the schedule you specify (natural language or cron).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'delete', 'pause', 'resume'],
          default: 'list',
        },
        description: {
          type: 'string',
          description: 'What should happen when this fires (for create).',
        },
        schedule: {
          type: 'string',
          description:
            'Natural language: "every weekday at 9am", "in 2 hours", or cron: "0 9 * * 1-5"',
        },
        working_dir: { type: 'string' },
        priority: {
          type: 'string',
          enum: ['low', 'normal', 'high', 'urgent'],
        },
        one_shot: {
          type: 'boolean',
          default: false,
          description: 'If true, fires once then auto-deletes.',
        },
        schedule_id: {
          type: 'string',
          description: 'For delete/pause/resume.',
        },
      },
    },
  },
  {
    name: 'kairos_observe',
    description:
      'View or manage environment observations. KAIROS watches your workspace and suggests actions — it never acts on its own.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'dismiss', 'act', 'scan_now'],
          default: 'list',
          description:
            'list = show active observations. dismiss = ignore one. act = create a task from observation suggestion. scan_now = force an immediate scan.',
        },
        observation_id: {
          type: 'string',
          description: 'For dismiss or act.',
        },
        category: {
          type: 'string',
          description: 'Filter by category.',
        },
      },
    },
  },
  {
    name: 'kairos_feedback',
    description:
      'Give explicit feedback to KAIROS. Helps it learn what you find useful vs. annoying. KAIROS evolves based on this.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        message_id: { type: 'string' },
        observation_id: { type: 'string' },
        rating: {
          type: 'string',
          enum: ['good', 'bad', 'useless', 'perfect'],
          description: 'How useful was this?',
        },
        comment: {
          type: 'string',
          description: 'Optional explanation.',
        },
      },
      required: ['rating'],
    },
  },
  {
    name: 'kairos_debug',
    description:
      "KAIROS's self-debugging surface. View recurring error patterns the daemon has detected in its own logs, force a scan, or unsilence a pattern that was already proposed. When error patterns hit threshold (3+ occurrences in 1h), KAIROS auto-invokes L5 to propose a patch.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['list', 'all', 'scan', 'unsilence'], default: 'list' },
        fingerprint: { type: 'string', description: 'For unsilence: which pattern.' },
      },
    },
  },
  {
    name: 'kairos_self_modify',
    description:
      "KAIROS's deepest self-evolution capability: propose modifications to its own TypeScript source code. KAIROS generates a unified diff via claude -p, validates that it applies cleanly AND compiles, then queues it for YOUR approval (source changes always require explicit consent). Approved patches trigger an automatic rebuild. Reverts are one command via the backup. Restricted to src/daemon/ and src/shim/ for safety.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['propose', 'list', 'pending', 'all', 'show', 'approve', 'apply', 'reject', 'revert'],
          default: 'pending',
        },
        target_file: { type: 'string', description: 'For propose: relative path under src/daemon or src/shim.' },
        reason: { type: 'string', description: 'For propose/reject: why.' },
        patch_id: { type: 'string', description: 'For show/approve/reject/revert.' },
        limit: { type: 'number', description: 'For all: max patches to return (default 20).' },
      },
    },
  },
  {
    name: 'kairos_prompts',
    description:
      "Manage KAIROS's evolving prompts. Each prompt (tick-decision, work-prompt, dream-prompt, system) can have multiple versions. Experiments run in parallel with production at 25% traffic. KAIROS auto-promotes versions that perform 15%+ better with 50+ samples. You can also manually create experiments, promote, or discard.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'metrics', 'experiment', 'promote', 'auto-promote', 'discard'],
          default: 'list',
        },
        prompt_name: { type: 'string', description: 'e.g., tick-decision, work-prompt, dream-prompt, system' },
        version: { type: 'string', description: 'For promote/discard.' },
        content: { type: 'string', description: 'For experiment: the new prompt content.' },
        notes: { type: 'string', description: 'For experiment: optional notes about what changed.' },
        min_samples: { type: 'number', description: 'For auto-promote: minimum sample size (default 50).' },
        min_improvement: { type: 'number', description: 'For auto-promote: minimum effectiveness lift (default 0.15 = 15%).' },
      },
    },
  },
  {
    name: 'kairos_gaps',
    description:
      'Discover and fill capability gaps in KAIROS. KAIROS analyzes recent failed tasks to detect what it was unable to do and suggests new skills. Use list to see active gaps, candidates to see proposal-worthy gaps, fill to have KAIROS auto-generate a skill for a gap, or dismiss to ignore.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'all', 'scan', 'candidates', 'fill', 'dismiss'],
          default: 'list',
        },
        gap_id: { type: 'string', description: 'Required for fill/dismiss.' },
        min_occurrences: { type: 'number', description: 'For candidates: minimum occurrence threshold (default 2).' },
      },
    },
  },
  {
    name: 'kairos_skills',
    description:
      'Manage KAIROS skills — extensible capabilities that can monitor anything, query anything, fetch anything. List/describe/invoke existing skills, or use "generate" to have KAIROS WRITE a brand new skill for you (self-coding). Generated skills are staged, validated, then auto-promoted to active.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'describe', 'invoke', 'reload', 'generate', 'staged', 'discard'],
          default: 'list',
          description:
            'list = show active skills. describe = details of one skill. invoke = run a skill. reload = re-scan skills directory. generate = create a NEW skill from natural-language description (KAIROS writes the script itself). staged = list skills awaiting validation. discard = remove a staged skill.',
        },
        name: {
          type: 'string',
          description: 'Skill name (required for describe/invoke/discard).',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional args passed to the skill script.',
        },
        description: {
          type: 'string',
          description: 'For generate: plain-language description of what the new skill should do.',
        },
        example_use: {
          type: 'string',
          description: 'For generate: optional example of how the skill would be used.',
        },
        output_format: {
          type: 'string',
          enum: ['json', 'text'],
          description: 'For generate: what format the skill should output. Defaults to json.',
        },
        category: {
          type: 'string',
          description: 'For generate: skill category (monitoring, query, action, etc.).',
        },
      },
    },
  },
]
