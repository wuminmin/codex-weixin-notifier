#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import { chromium } from "playwright-core";

const DEFAULT_WIDTH = 920;
const DEFAULT_MAX_CHARS = 120_000;
const DEFAULT_MAX_HEIGHT = 30000;
const DEFAULT_TITLE = "Codex Weixin";
const DEFAULT_DEVICE_SCALE_FACTOR = 2;
const MIN_IMAGE_HEIGHT = 120;
const CHROME_CANDIDATES = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
];

function coercePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function findChromePath(requested = "") {
  const candidate = String(requested || "").trim();
  if (candidate) {
    if (fs.existsSync(candidate)) return candidate;
    throw new Error(`Chrome executable not found: ${candidate}`);
  }
  const found = CHROME_CANDIDATES.find((item) => fs.existsSync(item));
  if (found) return found;
  throw new Error("Chrome executable not found. Set CODEX_WEIXIN_CHROME_PATH or chromePath.");
}

function clampText(text, maxChars) {
  const value = String(text || "").replace(/\r\n/g, "\n").trimEnd();
  if (value.length <= maxChars) return { text: value, truncated: false };
  const suffix = "\n\n_输出已超过 markdownImageMaxChars，后续内容已截断，避免微信图片过大。_";
  return {
    text: `${value.slice(0, Math.max(0, maxChars - suffix.length)).trimEnd()}${suffix}`,
    truncated: true,
  };
}

function pageHtml({ body, title }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:;">
<title>${escapeHtml(title)}</title>
<style>
:root {
  color-scheme: dark;
  background: #090d12;
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  background: #090d12;
  color: #d7dde8;
  font: 16px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", "Noto Sans Mono CJK SC", "Microsoft YaHei Mono", monospace;
  letter-spacing: 0;
}
.terminal {
  padding: 22px 24px 24px;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.025), rgba(255, 255, 255, 0) 140px),
    #090d12;
}
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #8b97a8;
  font-size: 13px;
  line-height: 1.2;
  margin-bottom: 14px;
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: #4dbf7d;
  box-shadow: 14px 0 #dcb75a, 28px 0 #d85f68;
  margin-right: 32px;
}
.content {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.content > :first-child {
  margin-top: 0;
}
.content > :last-child {
  margin-bottom: 0;
}
p, ul, ol, blockquote, pre, table {
  margin: 0 0 14px;
}
ul, ol {
  padding-left: 1.5em;
}
li + li {
  margin-top: 4px;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: #101720;
  border: 1px solid #243040;
  border-radius: 8px;
  padding: 14px 16px;
  color: #e2e8f2;
}
code {
  font-family: inherit;
  background: #101720;
  border: 1px solid #243040;
  border-radius: 5px;
  padding: 0.08em 0.28em;
  color: #eef4ff;
}
pre code {
  background: transparent;
  border: 0;
  border-radius: 0;
  padding: 0;
}
blockquote {
  color: #b8c2d1;
  border-left: 3px solid #3a82f6;
  padding-left: 12px;
}
a {
  color: #58b7ff;
  text-decoration: none;
}
hr {
  border: 0;
  border-top: 1px solid #243040;
  margin: 18px 0;
}
table {
  width: 100%;
  border-collapse: collapse;
}
th, td {
  border: 1px solid #243040;
  padding: 7px 9px;
  text-align: left;
  vertical-align: top;
}
th {
  background: #101720;
  color: #f0f5ff;
}
strong {
  color: #f4f7fb;
}
em {
  color: #c6d3e4;
}
</style>
</head>
<body>
  <section class="terminal">
    <div class="bar"><span class="dot"></span><span>${escapeHtml(title)}</span></div>
    <main class="content">${body}</main>
  </section>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function terminalSnapshotMarkdown({ taskId = "", sessionName = "", paneText = "" }) {
  const header = [
    taskId ? `task ${taskId} · tmux snapshot` : "tmux snapshot",
    sessionName ? `session: ${sessionName}` : "",
  ].filter(Boolean).join("\n");
  const fenceSafe = String(paneText || "").replace(/```/g, "`\u200b``");
  return `${header}\n\n\`\`\`text\n${fenceSafe.trimEnd() || "(empty pane)"}\n\`\`\``;
}

function pageImagePath(dir, pageIndex, pageCount) {
  if (pageCount === 1) return path.join(dir, "reply.png");
  return path.join(dir, `reply-${String(pageIndex + 1).padStart(2, "0")}.png`);
}

export async function renderMarkdownImages(markdown, options = {}) {
  const maxChars = coercePositiveInteger(options.maxChars, DEFAULT_MAX_CHARS);
  const width = coercePositiveInteger(options.width, DEFAULT_WIDTH);
  const maxHeight = coercePositiveInteger(options.maxHeight, DEFAULT_MAX_HEIGHT);
  const deviceScaleFactor = coercePositiveInteger(options.deviceScaleFactor, DEFAULT_DEVICE_SCALE_FACTOR);
  const title = String(options.title || DEFAULT_TITLE);
  const chromePath = findChromePath(options.chromePath || process.env.CODEX_WEIXIN_CHROME_PATH);
  const { text, truncated } = clampText(markdown, maxChars);
  const body = await marked.parse(text, {
    async: false,
    breaks: true,
    gfm: true,
    mangle: false,
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-md-"));
  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-setuid-sandbox",
    ],
  });
  try {
    const page = await browser.newPage({
      deviceScaleFactor,
      viewport: { width, height: 800 },
    });
    await page.setContent(pageHtml({ body, title }), { waitUntil: "load" });
    await page.evaluate(() => document.fonts?.ready);
    const contentHeight = await page.$eval(".terminal", (element) => {
      return Math.ceil(element.getBoundingClientRect().height);
    });
    const totalHeight = Math.max(contentHeight, MIN_IMAGE_HEIGHT);
    const pageHeight = Math.max(Math.floor(maxHeight / deviceScaleFactor), MIN_IMAGE_HEIGHT);
    const pageCount = Math.max(1, Math.ceil(totalHeight / pageHeight));
    const filePaths = [];
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      const offset = pageIndex * pageHeight;
      const remaining = totalHeight - offset;
      const height = Math.min(pageHeight, Math.max(remaining, MIN_IMAGE_HEIGHT));
      await page.setViewportSize({ width, height });
      await page.evaluate((y) => {
        window.scrollTo(0, y);
      }, offset);
      const filePath = pageImagePath(dir, pageIndex, pageCount);
      await page.screenshot({
        path: filePath,
        type: "png",
      });
      filePaths.push(filePath);
    }
    return {
      filePath: filePaths[0],
      filePaths,
      pageCount,
      pageHeight,
      maxHeight,
      deviceScaleFactor,
      contentHeight,
      truncated,
      charCount: text.length,
      chromePath,
    };
  } finally {
    await browser.close();
  }
}

export async function renderMarkdownImage(markdown, options = {}) {
  const rendered = await renderMarkdownImages(markdown, options);
  return {
    ...rendered,
    filePath: rendered.filePaths[0],
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function cli() {
  const input = process.argv.length > 2 ? process.argv.slice(2).join(" ") : await readStdin();
  const result = await renderMarkdownImages(input || "Codex Weixin markdown image smoke test.");
  process.stdout.write(`${result.filePaths.join("\n")}\n`);
}

const selfPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === selfPath) {
  cli().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
