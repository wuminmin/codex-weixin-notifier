#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";

const DEFAULT_WIDTH = 920;
const DEFAULT_MAX_CHARS = 120_000;
const DEFAULT_MAX_HEIGHT = 30000;
const DEFAULT_TITLE = "Codex Weixin";
const DEFAULT_DEVICE_SCALE_FACTOR = 2;
const MIN_IMAGE_HEIGHT = 120;

const COLORS = {
  bg: "#090d12",
  fg: "#d7dde8",
  title: "#8b97a8",
  codeBg: "#101720",
  codeBorder: "#243040",
  codeFg: "#e2e8f2",
  strong: "#f4f7fb",
  em: "#c6d3e4",
  accent: "#58b7ff",
  quote: "#b8c2d1",
  quoteBorder: "#3a82f6",
  border: "#243040",
  heading: "#f4f7fb",
};

const FONT_FAMILY = '"WenQuanYi Micro Hei Mono", "WenQuanYi Micro Hei", "Noto Sans Mono CJK SC", "Noto Sans CJK SC", "Microsoft YaHei Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

function coercePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
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

function pageImagePath(dir, pageIndex, pageCount) {
  if (pageCount === 1) return path.join(dir, "reply.png");
  return path.join(dir, `reply-${String(pageIndex + 1).padStart(2, "0")}.png`);
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function parseInline(text) {
  const tokens = [];
  const regex = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|\*([^*]+)\*/gu;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: "text", value: text.slice(lastIndex, match.index) });
    }
    if (match[1] !== undefined) tokens.push({ type: "bold", value: match[1] });
    else if (match[2] !== undefined) tokens.push({ type: "code", value: match[2] });
    else if (match[3] !== undefined) tokens.push({ type: "link", text: match[3], url: match[4] });
    else if (match[5] !== undefined) tokens.push({ type: "em", value: match[5] });
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    tokens.push({ type: "text", value: text.slice(lastIndex) });
  }
  return tokens;
}

function parseBlocks(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  const isBlockStart = (line) => /^```/.test(line.trim())
    || /^#{1,6}\s/.test(line)
    || /^>\s?/.test(line)
    || /^\s*[-*+]\s/.test(line)
    || /^\s*\d+\.\s/.test(line)
    || /^[-*_]{3,}\s*$/.test(line.trim())
    || /^\|.*\|\s*$/.test(line);
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line.trim())) {
      const lang = line.trim().slice(3).trim();
      const codeLines = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        codeLines.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push({ type: "code", lang, content: codeLines.join("\n") });
    } else if (/^#{1,6}\s/.test(line)) {
      const level = (line.match(/^(#+)/) || ["#"])[1].length;
      blocks.push({ type: "heading", level, content: line.replace(/^#+\s/, "") });
      i += 1;
    } else if (/^>\s?/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push({ type: "quote", content: quoteLines.join("\n") });
    } else if (/^\s*[-*+]\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s/, ""));
        i += 1;
      }
      blocks.push({ type: "ul", items });
    } else if (/^\s*\d+\.\s/.test(line)) {
      const items = [];
      let n = 1;
      while (i < lines.length && /^\s*\d+\.\s/.test(lines[i])) {
        items.push({ num: n, content: lines[i].replace(/^\s*\d+\.\s/, "") });
        n += 1;
        i += 1;
      }
      blocks.push({ type: "ol", items });
    } else if (/^[-*_]{3,}\s*$/.test(line.trim())) {
      blocks.push({ type: "hr" });
      i += 1;
    } else if (/^\|.*\|\s*$/.test(line)) {
      const tableLines = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) {
        tableLines.push(lines[i]);
        i += 1;
      }
      blocks.push({ type: "table", lines: tableLines });
    } else if (line.trim() === "") {
      i += 1;
    } else {
      const paraLines = [];
      while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i])) {
        paraLines.push(lines[i]);
        i += 1;
      }
      blocks.push({ type: "paragraph", content: paraLines.join(" ") });
    }
  }
  return blocks;
}

function setFont(ctx, { size, bold = false }) {
  ctx.font = `${bold ? "bold " : ""}${size}px ${FONT_FAMILY}`;
}

function measureToken(ctx, token, size) {
  if (token.type === "code") {
    setFont(ctx, { size });
    const text = ` ${token.value} `;
    return ctx.measureText(text).width + 4;
  }
  if (token.type === "link") {
    setFont(ctx, { size });
    return ctx.measureText(token.text).width;
  }
  setFont(ctx, { size, bold: token.type === "bold" });
  return ctx.measureText(token.value).width;
}

function wrapInline(ctx, tokens, maxWidth, size) {
  const lines = [];
  let currentLine = [];
  let x = 0;
  const breakToken = (token) => {
    const chars = Array.from(token.type === "link" ? token.text : token.value);
    let chunk = "";
    const flush = () => {
      if (!chunk) return;
      const piece = { ...token };
      if (token.type === "link") piece.text = chunk;
      else piece.value = chunk;
      const pieceWidth = measureToken(ctx, piece, size);
      currentLine.push(piece);
      x += pieceWidth;
      chunk = "";
    };
    for (const char of chars) {
      const candidate = chunk + char;
      const candidateWidth = measureToken(ctx, { ...token, value: candidate, text: candidate }, size);
      const occupied = token.type === "code" ? candidateWidth : candidateWidth;
      if (x + occupied > maxWidth && chunk) {
        flush();
        lines.push(currentLine);
        currentLine = [];
        x = 0;
        chunk = char;
      } else {
        chunk = candidate;
      }
    }
    flush();
  };
  for (const token of tokens) {
    const width = measureToken(ctx, token, size);
    if (x + width > maxWidth && currentLine.length > 0) {
      lines.push(currentLine);
      currentLine = [];
      x = 0;
    }
    if (width > maxWidth) {
      breakToken(token);
    } else {
      currentLine.push(token);
      x += width;
    }
  }
  if (currentLine.length > 0) lines.push(currentLine);
  return lines;
}

function wrapPlain(ctx, text, maxWidth, size, bold = false) {
  setFont(ctx, { size, bold });
  const lines = [];
  let line = "";
  for (const char of Array.from(text)) {
    const candidate = line + char;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = char;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawInlineLine(ctx, line, x, baselineY, size) {
  let curX = x;
  for (const token of line) {
    if (token.type === "code") {
      setFont(ctx, { size });
      const text = ` ${token.value} `;
      const textWidth = ctx.measureText(text).width;
      const boxW = textWidth + 4;
      const boxH = size * 1.45;
      ctx.fillStyle = COLORS.codeBg;
      roundRect(ctx, curX, baselineY - size, boxW, boxH, 4);
      ctx.fill();
      ctx.fillStyle = COLORS.codeFg;
      ctx.fillText(text, curX + 2, baselineY);
      curX += boxW;
    } else if (token.type === "link") {
      setFont(ctx, { size });
      ctx.fillStyle = COLORS.accent;
      ctx.fillText(token.text, curX, baselineY);
      curX += ctx.measureText(token.text).width;
    } else {
      setFont(ctx, { size, bold: token.type === "bold" });
      ctx.fillStyle = token.type === "bold" ? COLORS.strong
        : token.type === "em" ? COLORS.em : COLORS.fg;
      ctx.fillText(token.value, curX, baselineY);
      curX += ctx.measureText(token.value).width;
    }
  }
}

function drawBlock(ctx, block, opts) {
  const { x, y, maxWidth, size, lineHeightPx, marginPx } = opts;
  let cursorY = y;
  if (block.type === "heading") {
    const level = Math.min(Math.max(block.level, 1), 6);
    const headingSize = Math.round(size * (level <= 1 ? 1.7 : level === 2 ? 1.45 : 1.25));
    setFont(ctx, { size: headingSize, bold: true });
    ctx.fillStyle = COLORS.heading;
    ctx.textBaseline = "alphabetic";
    const lines = wrapPlain(ctx, block.content, maxWidth, headingSize, true);
    for (const line of lines) {
      cursorY += headingSize * 1.2;
      ctx.fillText(line, x, cursorY);
    }
    cursorY += marginPx;
  } else if (block.type === "paragraph") {
    setFont(ctx, { size });
    ctx.textBaseline = "alphabetic";
    const lines = wrapInline(ctx, parseInline(block.content), maxWidth, size);
    for (const line of lines) {
      cursorY += lineHeightPx;
      drawInlineLine(ctx, line, x, cursorY, size);
    }
    cursorY += marginPx;
  } else if (block.type === "code") {
    setFont(ctx, { size });
    ctx.textBaseline = "alphabetic";
    const padding = 14;
    const codeLineHeight = Math.round(size * 1.45);
    const innerWidth = maxWidth - padding * 2;
    const wrappedLines = [];
    for (const codeLine of block.content.split("\n")) {
      const wrapped = wrapPlain(ctx, codeLine || " ", innerWidth, size);
      for (const w of wrapped) wrappedLines.push(w);
    }
    const blockHeight = padding * 2 + Math.max(1, wrappedLines.length) * codeLineHeight;
    ctx.fillStyle = COLORS.codeBg;
    roundRect(ctx, x, cursorY, maxWidth, blockHeight, 8);
    ctx.fill();
    ctx.strokeStyle = COLORS.codeBorder;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = COLORS.codeFg;
    let textY = cursorY + padding + size;
    for (const wline of wrappedLines) {
      ctx.fillText(wline, x + padding, textY);
      textY += codeLineHeight;
    }
    cursorY += blockHeight + marginPx;
  } else if (block.type === "ul" || block.type === "ol") {
    setFont(ctx, { size });
    ctx.textBaseline = "alphabetic";
    const indent = block.type === "ol" ? 32 : 20;
    for (let idx = 0; idx < block.items.length; idx += 1) {
      const item = block.items[idx];
      const marker = block.type === "ol" ? `${item.num}. ` : "• ";
      const itemContent = block.type === "ol" ? item.content : item;
      const lines = wrapInline(ctx, parseInline(itemContent), maxWidth - indent, size);
      ctx.fillStyle = COLORS.fg;
      ctx.fillText(marker, x, cursorY + lineHeightPx);
      for (let li = 0; li < lines.length; li += 1) {
        cursorY += lineHeightPx;
        drawInlineLine(ctx, lines[li], x + indent, cursorY, size);
      }
    }
    cursorY += marginPx;
  } else if (block.type === "quote") {
    setFont(ctx, { size });
    ctx.textBaseline = "alphabetic";
    const quotePad = 14;
    const lines = wrapInline(ctx, parseInline(block.content), maxWidth - quotePad - 8, size);
    const quoteHeight = lines.length * lineHeightPx + 12;
    ctx.fillStyle = COLORS.quoteBorder;
    ctx.fillRect(x, cursorY + 6, 3, quoteHeight - 12);
    cursorY += 6;
    ctx.fillStyle = COLORS.quote;
    for (const line of lines) {
      cursorY += lineHeightPx;
      drawInlineLine(ctx, line.map((t) => (t.type === "text" ? { ...t, type: "text" } : t)), x + quotePad, cursorY, size);
    }
    cursorY += marginPx;
  } else if (block.type === "hr") {
    cursorY += 12;
    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, cursorY);
    ctx.lineTo(x + maxWidth, cursorY);
    ctx.stroke();
    cursorY += marginPx;
  } else if (block.type === "table") {
    setFont(ctx, { size });
    ctx.textBaseline = "alphabetic";
    const rows = [];
    for (let r = 0; r < block.lines.length; r += 1) {
      if (/^\|\s*[-:]+[-|\s:]+/.test(block.lines[r])) continue;
      const cells = block.lines[r].split("|").slice(1, -1).map((c) => c.trim());
      rows.push({ cells, header: r === 0 });
    }
    for (const row of rows) {
      setFont(ctx, { size, bold: row.header });
      ctx.fillStyle = row.header ? COLORS.strong : COLORS.fg;
      const text = row.cells.join("    |    ");
      const lines = wrapPlain(ctx, text, maxWidth, size, row.header);
      for (const line of lines) {
        cursorY += lineHeightPx;
        ctx.fillText(line, x, cursorY);
      }
    }
    cursorY += marginPx;
  }
  return cursorY;
}

export function terminalSnapshotMarkdown({ taskId = "", sessionName = "", paneText = "" }) {
  const header = [
    taskId ? `task ${taskId} · tmux snapshot` : "tmux snapshot",
    sessionName ? `session: ${sessionName}` : "",
  ].filter(Boolean).join("\n");
  const fenceSafe = String(paneText || "").replace(/```/g, "`\u200b``");
  return `${header}\n\n\`\`\`text\n${fenceSafe.trimEnd() || "(empty pane)"}\n\`\`\``;
}

export async function renderMarkdownImages(markdown, options = {}) {
  const maxChars = coercePositiveInteger(options.maxChars, DEFAULT_MAX_CHARS);
  const logicalWidth = coercePositiveInteger(options.width, DEFAULT_WIDTH);
  const maxHeight = coercePositiveInteger(options.maxHeight, DEFAULT_MAX_HEIGHT);
  const deviceScaleFactor = coercePositiveInteger(options.deviceScaleFactor, DEFAULT_DEVICE_SCALE_FACTOR);
  const title = String(options.title || DEFAULT_TITLE);
  const { text, truncated } = clampText(markdown, maxChars);

  const px = (n) => Math.round(n * deviceScaleFactor);
  const canvasWidth = px(logicalWidth);
  const paddingX = px(24);
  const paddingY = px(22);
  const fontSize = px(16);
  const lineHeightPx = Math.round(fontSize * 1.55);
  const marginPx = Math.round(fontSize * 0.85);
  const innerWidth = canvasWidth - paddingX * 2;

  const blocks = parseBlocks(text);

  const measureCanvas = createCanvas(canvasWidth, 64);
  const measureCtx = measureCanvas.getContext("2d");

  const titleSize = px(13);
  setFont(measureCtx, { size: titleSize });
  const titleHeight = titleSize * 1.2 + px(14);

  let contentHeight = paddingY + titleHeight;
  const layoutCtx = measureCtx;
  for (const block of blocks) {
    contentHeight = drawBlock(layoutCtx, block, {
      x: paddingX,
      y: contentHeight,
      maxWidth: innerWidth,
      size: fontSize,
      lineHeightPx,
      marginPx,
    });
  }
  contentHeight += paddingY;
  const totalHeight = Math.max(contentHeight, px(MIN_IMAGE_HEIGHT) / deviceScaleFactor);

  const mainCanvas = createCanvas(canvasWidth, totalHeight);
  const ctx = mainCanvas.getContext("2d");
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, canvasWidth, totalHeight);

  setFont(ctx, { size: titleSize });
  ctx.fillStyle = COLORS.title;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(title, paddingX, paddingY + titleSize);

  let drawY = paddingY + titleHeight;
  for (const block of blocks) {
    drawY = drawBlock(ctx, block, {
      x: paddingX,
      y: drawY,
      maxWidth: innerWidth,
      size: fontSize,
      lineHeightPx,
      marginPx,
    });
  }

  const pageHeight = Math.max(Math.floor(maxHeight), px(MIN_IMAGE_HEIGHT) / deviceScaleFactor);
  const pageCount = Math.max(1, Math.ceil(totalHeight / pageHeight));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-md-"));
  const filePaths = [];
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const offset = pageIndex * pageHeight;
    const height = Math.min(pageHeight, totalHeight - offset);
    const pageCanvas = createCanvas(canvasWidth, height);
    const pageCtx = pageCanvas.getContext("2d");
    const imageData = ctx.getImageData(0, offset, canvasWidth, height);
    pageCtx.putImageData(imageData, 0, 0);
    const filePath = pageImagePath(dir, pageIndex, pageCount);
    fs.writeFileSync(filePath, pageCanvas.toBuffer("image/png"));
    filePaths.push(filePath);
  }

  return {
    filePath: filePaths[0],
    filePaths,
    pageCount,
    pageHeight,
    maxHeight,
    deviceScaleFactor,
    contentHeight: totalHeight,
    truncated,
    charCount: text.length,
  };
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
