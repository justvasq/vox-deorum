#!/usr/bin/env node
// Builds a static, browsable site from docs/developers/**/*.md.
//
// - Every .md file becomes its own HTML page at the same relative path.
// - Every directory (docs/developers/ itself, and each subfolder) gets an
//   auto-generated index.html listing its contents (no hand-maintained nav
//   tree; new files/folders are picked up automatically).
// - A single shared CSS/layout gives every page a left sidebar (the full
//   docs/developers/ tree, current page highlighted, containing folder open)
//   plus a breadcrumb and folder tag.
// - Output goes to OUT_DIR (default: site-dist/), which is git-ignored;
//   the GitHub Pages workflow runs this script and publishes OUT_DIR.
//
// Usage: node scripts/build-docs-site.mjs [--out <dir>] [--base <path>]
//   --base sets the site's root URL path (e.g. "/vox-deorum/" for GitHub
//   Pages project sites); defaults to "/".

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = path.join(REPO_ROOT, 'docs', 'developers');

const args = process.argv.slice(2);
function argVal(flag, fallback) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const OUT_DIR = path.resolve(REPO_ROOT, argVal('--out', 'site-dist'));
let BASE = argVal('--base', '/');
if (!BASE.endsWith('/')) BASE += '/';
if (!BASE.startsWith('/')) BASE = '/' + BASE;

// ---------------------------------------------------------------------------
// 1. Walk docs/developers/, building a tree of { type: 'dir'|'file', name, relPath, children }

function walk(absDir, relDir) {
  const entries = fs.readdirSync(absDir, { withFileTypes: true })
    .filter(e => !e.name.startsWith('.'))
    .sort((a, b) => {
      // Directories first, then files, both alphabetically.
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  const children = [];
  for (const e of entries) {
    const absPath = path.join(absDir, e.name);
    const relPath = path.join(relDir, e.name);
    if (e.isDirectory()) {
      const sub = walk(absPath, relPath);
      if (sub.children.length) children.push(sub);
    } else if (e.isFile() && e.name.endsWith('.md')) {
      children.push({ type: 'file', name: e.name, relPath, absPath });
    }
  }
  return { type: 'dir', name: path.basename(absDir), relPath: relDir, children };
}

const tree = walk(SRC_ROOT, '');
tree.name = 'docs/developers';

// ---------------------------------------------------------------------------
// 2. Helpers: title-casing, output paths, url resolution

function titleCase(basename) {
  return basename
    .replace(/\.md$/, '')
    .split(/[-_]/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Output path for a source file: docs/developers/foo/bar.md -> foo/bar.html
function outPathForFile(relPath) {
  return relPath.replace(/\.md$/, '.html');
}
// Output path for a directory's index: '' -> index.html, 'foo' -> foo/index.html
function outPathForDir(relDir) {
  return relDir ? path.join(relDir, 'index.html') : 'index.html';
}
// Absolute site URL (from BASE) for a given output-relative path, e.g. "foo/bar.html"
function siteUrl(outRelPath) {
  return BASE + outRelPath.split(path.sep).join('/');
}

// Build a lookup: source .md relPath -> site URL, and dir relPath -> its index URL.
const fileUrl = new Map();
const dirUrl = new Map();
(function index(node) {
  if (node.type === 'dir') {
    dirUrl.set(node.relPath, siteUrl(outPathForDir(node.relPath)));
    for (const c of node.children) index(c);
  } else {
    fileUrl.set(node.relPath, siteUrl(outPathForFile(node.relPath)));
  }
})(tree);

// Relative path resolution for markdown links, e.g. from
// "civ5-dll/unit-ai/overview.md" a link to "../connection.md" resolves
// against SRC_ROOT-relative paths.
function resolveMdLink(fromRelPath, link) {
  const [rawPath, frag] = link.split('#');
  if (!rawPath) return null; // pure in-page fragment
  const fromDir = path.posix.dirname(fromRelPath.split(path.sep).join('/'));
  const resolved = path.posix.normalize(path.posix.join(fromDir, rawPath));
  if (fileUrl.has(resolved)) return fileUrl.get(resolved) + (frag ? '#' + frag : '');
  return null;
}

// ---------------------------------------------------------------------------
// 3. Minimal markdown -> HTML (same subset as the docs actually use: headers,
//    paragraphs, nested lists, tables, fenced code incl. mermaid, inline
//    code/bold/italic/links, hr).

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderInline(text, fromRelPath) {
  const codeSpans = [];
  text = text.replace(/`([^`]+)`/g, (_, code) => {
    codeSpans.push(escapeHtml(code));
    return `@@CODE${codeSpans.length - 1}@@`;
  });
  text = escapeHtml(text);
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    if (/^https?:\/\//.test(url) || url.startsWith('#')) {
      return `<a href="${url}">${label}</a>`;
    }
    const href = resolveMdLink(fromRelPath, url);
    if (href) return `<a href="${href}">${label}</a>`;
    // Link to a file outside docs/developers/, or a genuinely missing target:
    // render as plain text (no dead links in a generated site).
    return label;
  });
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  text = text.replace(/@@CODE(\d+)@@/g, (_, i) => `<code>${codeSpans[+i]}</code>`);
  return text;
}

function renderMarkdown(md, fromRelPath) {
  const lines = md.split('\n');
  let html = [];
  let i = 0;
  let firstH1 = null;

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      if (lang === 'mermaid') {
        html.push(`<pre class="mermaid">\n${escapeHtml(buf.join('\n'))}\n</pre>`);
      } else {
        html.push(`<pre><code${lang ? ` class="lang-${lang}"` : ''}>${escapeHtml(buf.join('\n'))}</code></pre>`);
      }
      continue;
    }

    let m = line.match(/^(#{1,4})\s+(.*)$/);
    if (m) {
      const level = m[1].length;
      const text = m[2].trim();
      if (level === 1 && firstH1 === null) firstH1 = text;
      const tag = level === 1 ? 'h1' : level === 2 ? 'h2' : level === 3 ? 'h3' : 'h4';
      const slug = text.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
      html.push(`<${tag} id="${slug}">${renderInline(text, fromRelPath)}</${tag}>`);
      i++;
      continue;
    }

    if (/^---+$/.test(line.trim())) { html.push('<hr>'); i++; continue; }

    if (/^\|/.test(line.trim()) && lines[i + 1] && /^\|?[\s:|-]+\|?$/.test(lines[i + 1].trim())) {
      const headerCells = line.trim().replace(/^\||\|$/g, '').split('|').map(s => s.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i].trim())) {
        rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map(s => s.trim()));
        i++;
      }
      let t = '<div class="tablewrap"><table><thead><tr>';
      for (const c of headerCells) t += `<th>${renderInline(c, fromRelPath)}</th>`;
      t += '</tr></thead><tbody>';
      for (const r of rows) {
        t += '<tr>';
        for (const c of r) t += `<td>${renderInline(c, fromRelPath)}</td>`;
        t += '</tr>';
      }
      t += '</tbody></table></div>';
      html.push(t);
      continue;
    }

    if (/^(\s*)([-*]|\d+\.)\s+/.test(line)) {
      function parseList(indentBase) {
        const items = [];
        while (i < lines.length) {
          const l = lines[i];
          const lm = l.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
          if (!lm) break;
          const indent = lm[1].length;
          if (indent < indentBase) break;
          if (indent > indentBase) {
            if (items.length === 0) break;
            const sub = parseList(indent);
            items[items.length - 1].sub = sub;
            continue;
          }
          const ordered = /\d+\./.test(lm[2]);
          items.push({ text: lm[3], ordered, sub: null });
          i++;
        }
        return items;
      }
      const items = parseList((line.match(/^(\s*)/) || ['', ''])[1].length);
      const ordered = items.length && items[0].ordered;
      function renderList(items, ordered) {
        const tag = ordered ? 'ol' : 'ul';
        let s = `<${tag}>`;
        for (const it of items) {
          s += `<li>${renderInline(it.text, fromRelPath)}`;
          if (it.sub) s += renderList(it.sub, it.sub[0]?.ordered);
          s += '</li>';
        }
        s += `</${tag}>`;
        return s;
      }
      html.push(renderList(items, ordered));
      continue;
    }

    if (line.trim() === '') { i++; continue; }

    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== '' &&
           !/^#{1,4}\s/.test(lines[i]) && !/^```/.test(lines[i]) &&
           !/^(\s*)([-*]|\d+\.)\s+/.test(lines[i]) && !/^\|/.test(lines[i].trim()) &&
           !/^---+$/.test(lines[i].trim())) {
      buf.push(lines[i]);
      i++;
    }
    html.push(`<p>${renderInline(buf.join(' '), fromRelPath)}</p>`);
  }

  return { html: html.join('\n'), title: firstH1 };
}

// ---------------------------------------------------------------------------
// 4. Shared layout: CSS + sidebar + page shell.

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Spectral:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Source+Sans+3:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
:root {
  --ink: #21201c; --paper: #faf8f4; --paper-raised: #ffffff;
  --accent: #8a3324; --accent-soft: #b8543f; --muted: #6b6457;
  --line: #ded8ca; --code-bg: #f0ede4; --code-ink: #4a3f2f;
  --callout-bg: #f3ece2; --shadow: rgba(33, 32, 28, 0.08);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ink: #e9e4d8; --paper: #1c1a16; --paper-raised: #242119;
    --accent: #e08a6f; --accent-soft: #c96a4f; --muted: #a49a86;
    --line: #3a352b; --code-bg: #262218; --code-ink: #d9cdb5;
    --callout-bg: #2a2419; --shadow: rgba(0, 0, 0, 0.35);
  }
}
:root[data-theme="dark"] {
  --ink: #e9e4d8; --paper: #1c1a16; --paper-raised: #242119;
  --accent: #e08a6f; --accent-soft: #c96a4f; --muted: #a49a86;
  --line: #3a352b; --code-bg: #262218; --code-ink: #d9cdb5;
  --callout-bg: #2a2419; --shadow: rgba(0, 0, 0, 0.35);
}
* { box-sizing: border-box; }
html, body {
  background: var(--paper); color: var(--ink);
  font-family: 'Source Sans 3', ui-sans-serif, system-ui, sans-serif;
  font-size: 17px; line-height: 1.65; -webkit-font-smoothing: antialiased;
  margin: 0;
}
.site { max-width: 1180px; margin: 0 auto; padding: 0 2rem; display: block; }
.site .page { max-width: 760px; margin: 0; padding: 3rem 0 6rem; }
@media (min-width: 1180px) {
  .site { display: grid; grid-template-columns: 240px minmax(0, 760px); gap: 3rem; align-items: start; padding: 0 2rem; }
}
aside.sidenav { display: none; }
@media (min-width: 1180px) {
  aside.sidenav {
    display: block; position: sticky; top: 0; max-height: 100vh; overflow-y: auto;
    padding: 3rem 0.4rem 3rem 0; font-size: 0.85rem;
  }
}
.sidenav .site-title {
  font-family: 'Spectral', Georgia, serif; font-weight: 600; font-size: 1.02rem;
  line-height: 1.3; margin-bottom: 1.6rem; text-decoration: none; color: var(--ink); display: block;
}
.sidenav .site-title:hover { color: var(--accent); }
.sidenav details { margin-bottom: 0.15rem; }
.sidenav summary {
  cursor: pointer; list-style: none;
  font-family: 'JetBrains Mono', monospace; font-size: 0.74rem; font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted);
  padding: 0.4rem 0.3rem 0.4rem 0; display: flex; align-items: center; gap: 0.4rem; border-radius: 4px;
}
.sidenav summary::-webkit-details-marker { display: none; }
.sidenav summary::before { content: '▸'; color: var(--accent); font-size: 0.7em; flex-shrink: 0; transition: transform 0.15s ease; }
.sidenav details[open] > summary::before { transform: rotate(90deg); }
.sidenav summary:hover { color: var(--ink); }
.sidenav .navlist {
  list-style: none; margin: 0.1rem 0 0.6rem; padding: 0 0 0 0.85rem;
  display: flex; flex-direction: column; gap: 0.28rem; border-left: 1px solid var(--line);
}
.sidenav .navlist.top { padding-left: 0; border-left: none; margin-bottom: 1.1rem; }
.sidenav .navlist a, .sidenav .navlist span.current {
  color: var(--muted); text-decoration: none; display: block;
  padding: 0.15rem 0 0.15rem 0.7rem; border-left: 2px solid transparent; margin-left: -1px;
}
.sidenav .navlist a:hover { color: var(--ink); border-left-color: var(--line); }
.sidenav .navlist a.current, .sidenav .navlist span.current { color: var(--accent); font-weight: 600; border-left-color: var(--accent); }
.sidenav .folder-link { color: var(--muted); text-decoration: none; flex: 1; }
.sidenav .folder-link:hover { color: var(--ink); }
.sidenav .folder-link.current { color: var(--accent); }
.crumb {
  font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; letter-spacing: 0.04em; color: var(--muted);
  margin-bottom: 1.6rem; display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center;
}
.crumb a { color: var(--accent-soft); text-decoration: none; }
.crumb a:hover { text-decoration: underline; }
.crumb .sep { color: var(--line); }
.folder-tag {
  font-family: 'JetBrains Mono', monospace; font-size: 0.72rem; font-weight: 500;
  letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent); margin-bottom: 0.6rem;
}
h1 {
  font-family: 'Spectral', Georgia, serif; font-weight: 600; font-size: 2.15rem; line-height: 1.16;
  letter-spacing: -0.01em; margin: 0 0 1.6rem; text-wrap: balance; padding-bottom: 1.3rem; border-bottom: 1px solid var(--line);
}
h2 { font-family: 'Spectral', Georgia, serif; font-weight: 600; font-size: 1.5rem; margin: 2.4rem 0 1rem; letter-spacing: -0.005em; text-wrap: balance; }
h3 { font-family: 'Spectral', Georgia, serif; font-weight: 600; font-size: 1.18rem; margin: 1.8rem 0 0.7rem; }
h4 {
  font-family: 'JetBrains Mono', monospace; font-size: 0.85rem; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.06em; color: var(--accent); margin: 1.4rem 0 0.6rem;
}
p { margin: 0 0 1.05rem; max-width: 68ch; }
ul, ol { margin: 0 0 1.05rem; padding-left: 1.3rem; max-width: 66ch; }
li { margin-bottom: 0.45rem; }
li::marker { color: var(--accent); }
li > ul, li > ol { margin-top: 0.45rem; }
strong { font-weight: 600; }
a { color: var(--accent-soft); }
a:hover { text-decoration-thickness: 2px; }
hr { border: none; border-top: 1px solid var(--line); margin: 2.4rem 0; }
code { font-family: 'JetBrains Mono', monospace; font-size: 0.86em; background: var(--code-bg); color: var(--code-ink); padding: 0.12em 0.4em; border-radius: 4px; }
pre { background: var(--code-bg); border: 1px solid var(--line); border-radius: 8px; padding: 1rem 1.1rem; overflow-x: auto; margin: 0 0 1.2rem; }
pre code { background: none; padding: 0; font-size: 0.85rem; line-height: 1.55; }
.tablewrap { overflow-x: auto; margin: 0 0 1.3rem; }
table { border-collapse: collapse; width: 100%; max-width: 68ch; font-size: 0.92rem; }
th, td { text-align: left; padding: 0.55rem 0.9rem 0.55rem 0; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-family: 'JetBrains Mono', monospace; font-size: 0.72rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); font-weight: 500; }
.readmap { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 1rem; margin: 1.6rem 0 1.3rem; }
.readmap .card { background: var(--paper-raised); border: 1px solid var(--line); border-radius: 8px; padding: 0.9rem 1.1rem; box-shadow: 0 1px 3px var(--shadow); }
.readmap .card h4 { font-family: 'JetBrains Mono', monospace; font-size: 0.88rem; font-weight: 600; margin: 0; }
.readmap .card h4 a { text-decoration: none; color: var(--ink); }
.readmap .card h4 a:hover { color: var(--accent); }
.readmap .card p { font-size: 0.82rem; margin: 0.35rem 0 0; color: var(--muted); }
::selection { background: var(--accent); color: var(--paper); }
`;

function crumbHtml(crumbs) {
  return `<div class="crumb">` + crumbs.map((c, idx) => {
    const sep = idx > 0 ? '<span class="sep">/</span>' : '';
    const item = c.href ? `<a href="${c.href}">${c.label}</a>` : `<span>${c.label}</span>`;
    return sep + item;
  }).join(' ') + `</div>`;
}

// Render the full sidebar tree, given the output-relative path of the page being rendered
// (used to mark "current" and auto-expand containing folders). currentKind is 'file'|'dir'.
function sidenavHtml(currentRelPath, currentKind) {
  function isCurrentFile(relPath) { return currentKind === 'file' && relPath === currentRelPath; }
  function isCurrentDir(relDir) { return currentKind === 'dir' && relDir === currentRelPath; }
  function containsCurrent(node) {
    if (node.type === 'file') return isCurrentFile(node.relPath);
    if (isCurrentDir(node.relPath)) return true;
    return node.children.some(containsCurrent);
  }

  function renderNode(node, depth) {
    if (node.type === 'file') {
      const cur = isCurrentFile(node.relPath);
      const url = fileUrl.get(node.relPath);
      const label = titleCase(node.name);
      return `<li>${cur ? `<span class="current">${label}</span>` : `<a href="${url}">${label}</a>`}</li>`;
    }
    // directory
    const open = containsCurrent(node) ? ' open' : '';
    const cur = isCurrentDir(node.relPath);
    const url = dirUrl.get(node.relPath);
    const inner = node.children.map(c => renderNode(c, depth + 1)).join('');
    return `<li><details${open}>
      <summary><a class="folder-link${cur ? ' current' : ''}" href="${url}">${node.name}</a></summary>
      <ul class="navlist">${inner}</ul>
    </details></li>`;
  }

  // Top level: root dir's direct file children render flat (no <details>), directories nest.
  const rootFiles = tree.children.filter(c => c.type === 'file');
  const rootDirs = tree.children.filter(c => c.type === 'dir');
  const topHtml = `<ul class="navlist top">` + rootFiles.map(f => {
    const cur = isCurrentFile(f.relPath);
    const url = fileUrl.get(f.relPath);
    const label = titleCase(f.name);
    return `<li>${cur ? `<span class="current">${label}</span>` : `<a href="${url}">${label}</a>`}</li>`;
  }).join('') + `</ul>`;
  const dirsHtml = rootDirs.map(d => renderNode(d, 0)).join('');

  return `<aside class="sidenav">
    <a class="site-title" href="${siteUrl('index.html')}">Vox Deorum Developer Docs</a>
    ${topHtml}
    <ul class="navlist top" style="border:none;padding:0;margin:0;">${dirsHtml}</ul>
  </aside>`;
}

function pageHtml({ title, folderTag, crumbs, bodyHtml, currentRelPath, currentKind }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${CSS}</style>
</head>
<body>
<div class="site">
  ${sidenavHtml(currentRelPath, currentKind)}
  <div class="page">
    ${crumbHtml(crumbs)}
    ${folderTag ? `<div class="folder-tag">${folderTag}</div>` : ''}
    ${bodyHtml}
  </div>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// 5. Render every file page and every directory index page.

fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

function writeOut(outRelPath, html) {
  const abs = path.join(OUT_DIR, outRelPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, html);
}

function crumbsFor(relPath, isDir) {
  const parts = relPath ? relPath.split(path.sep) : [];
  const crumbs = [{ label: 'docs/developers', href: siteUrl('index.html') }];
  let acc = '';
  parts.forEach((part, idx) => {
    acc = acc ? path.join(acc, part) : part;
    const isLast = idx === parts.length - 1;
    if (isLast && !isDir) {
      // file: label is its title, no href (current)
      return;
    }
    crumbs.push({ label: part, href: isLast ? undefined : dirUrl.get(acc) });
  });
  return crumbs;
}

let fileCount = 0;
function renderFile(node) {
  const md = fs.readFileSync(node.absPath, 'utf8');
  const { html, title } = renderMarkdown(md, node.relPath);
  const pageTitle = title || titleCase(node.name);
  const folderTag = 'docs/developers/' + (path.dirname(node.relPath) === '.' ? '' : path.dirname(node.relPath));
  const crumbs = crumbsFor(node.relPath, false);
  crumbs[crumbs.length - 1] = { label: pageTitle }; // replace last with actual page title (no href)
  const page = pageHtml({
    title: `${pageTitle} — Vox Deorum Dev Docs`,
    folderTag,
    crumbs,
    bodyHtml: html,
    currentRelPath: node.relPath,
    currentKind: 'file',
  });
  writeOut(outPathForFile(node.relPath), page);
  fileCount++;
}

function renderDirIndex(node) {
  const isRoot = node.relPath === '';
  const label = isRoot ? 'docs/developers' : node.name;
  const cards = node.children.map(c => {
    if (c.type === 'dir') {
      const fileCountInDir = countFiles(c);
      return `<div class="card"><h4><a href="${dirUrl.get(c.relPath)}">${c.name} →</a></h4><p>${fileCountInDir} page${fileCountInDir === 1 ? '' : 's'}</p></div>`;
    }
    return `<div class="card"><h4><a href="${fileUrl.get(c.relPath)}">${titleCase(c.name)}</a></h4></div>`;
  }).join('');

  const crumbs = isRoot
    ? [{ label: 'docs/developers' }]
    : (() => { const cr = crumbsFor(node.relPath, true); cr[cr.length - 1] = { label: node.name }; return cr; })();

  const bodyHtml = `<h1>${label}</h1>
    <p>${isRoot ? 'Developer documentation for Vox Deorum, organized by component.' : `Contents of <code>docs/developers/${node.relPath.split(path.sep).join('/')}/</code>.`}</p>
    <div class="readmap">${cards}</div>`;

  const page = pageHtml({
    title: `${label} — Vox Deorum Dev Docs`,
    folderTag: isRoot ? undefined : 'docs/developers/' + node.relPath.split(path.sep).join('/'),
    crumbs,
    bodyHtml,
    currentRelPath: node.relPath,
    currentKind: 'dir',
  });
  writeOut(outPathForDir(node.relPath), page);
}

function countFiles(node) {
  if (node.type === 'file') return 1;
  return node.children.reduce((sum, c) => sum + countFiles(c), 0);
}

(function renderAll(node) {
  if (node.type === 'file') {
    renderFile(node);
  } else {
    renderDirIndex(node);
    for (const c of node.children) renderAll(c);
  }
})(tree);

console.log(`Built ${fileCount} doc pages + directory indexes into ${path.relative(REPO_ROOT, OUT_DIR)}/ (base: ${BASE})`);
