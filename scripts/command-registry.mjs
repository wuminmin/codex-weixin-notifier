export const AGENT_NAMES = ["codex", "claude", "opencode"];

export const HELP_TOPICS = {
  start: [
    "Getting started / 入门",
    "1. Configure: onboard / 配置",
    "2. Choose: tool use codex | claude | opencode",
    "3. Send a task; the selected agent starts only then",
    "Run tool doctor / 工具诊断 before troubleshooting.",
  ],
  agent: [
    "Agents / 智能体",
    "tool use codex | tool use claude | tool use opencode",
    "tool use claude 1 - select a logical Claude Code session",
    "tool list / 工具列表 - show selection, readiness, and sessions",
    "tool doctor / 工具诊断 - inspect agent, tmux, and router readiness",
    "tool off / 工具退出 - clear the current selection; no Codex fallback",
    "Legacy: claude 1 [prompt] | opencode 1 [prompt]",
  ],
  task: [
    "Phone sessions / 手机会话",
    "history | sessions / 历史 | 会话",
    "takeover N / 接管 N",
    "current session / 当前会话",
    "new session [codex|claude|opencode] / 新会话 [工具]",
    "session off / 退出接管",
  ],
  monitor: [
    "Monitoring / 监控",
    "list | tasks / 列表 | 任务 - list tasks",
    "progress / 进度 - show active tasks",
    "status / 状态 - show connection and runtime status",
    "tool doctor / 工具诊断 - show local execution readiness",
  ],
  files: [
    "Files and directories / 文件",
    "pwd / 当前目录",
    "ls [path] / 列文件 [path]",
    "ls -la [path] / 列文件 -la [path]",
    "You can also send an image or file as an attachment.",
    "Attachments wait until an agent is selected, then replay once.",
  ],
  admin: [
    "Administration / 管理",
    "onboard | 配置 | 设置 - show connection and configuration entry",
    "Local setup: catm --help",
    "Control commands do not require Codex, Claude Code, or opencode.",
  ],
};

export const COMMAND_REGISTRY = [
  { id: "help", syntax: "help [topic] / 帮助 [主题] / ?", topics: ["start", "agent", "task", "monitor", "files", "admin", "all"] },
  { id: "onboard", syntax: "onboard | 配置 | 设置" },
  { id: "monitor", syntax: "list | tasks | progress | status / 列表 | 任务 | 进度 | 状态" },
  { id: "agent-select", syntax: "tool use codex|claude|opencode [N]" },
  { id: "agent-control", syntax: "tool list | tool doctor | tool off" },
  { id: "agent-close", syntax: "tool close claude|opencode N" },
  { id: "session", syntax: "history|takeover N|current session|new session|session off" },
  { id: "files", syntax: "pwd | ls [flags] [path] / 当前目录 | 列文件" },
  { id: "codex-native", syntax: "plan <text> | goal <text> / 计划 <内容> | 目标 <内容>" },
  { id: "goal", syntax: "goal status|pause|resume|clear / 目标 状态|暂停|继续|清除" },
  { id: "legacy-agent", syntax: "claude N [prompt] | opencode N [prompt] (legacy)" },
];

const TOPIC_ALIASES = {
  入门: "start",
  智能体: "agent",
  任务: "task",
  监控: "monitor",
  文件: "files",
  管理: "admin",
  全部: "all",
};

export function normalizeHelpTopic(topic = "") {
  const value = String(topic || "").trim().toLowerCase().replace(/^(?:help|帮助)\s+/u, "");
  return TOPIC_ALIASES[value] || value;
}

export function allCommandLines() {
  return [
    "Full command reference / 完整命令清单",
    ...COMMAND_REGISTRY.map((command) => command.syntax),
    "Attachments are held until an agent is selected, then replayed once.",
  ];
}
