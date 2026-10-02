import { StreamLanguage, type LanguageSupport, type StreamParser } from '@codemirror/language'
import type { Extension } from '@codemirror/state'

/**
 * Tên file → tô màu cú pháp. Nạp lười từng gói (chỉ tải khi mở loại file đó). Không nhận ra →
 * văn bản thường.
 */

export interface LanguageInfo {
  id: string
  label: string
  load: () => Promise<Extension>
}

const legacy = (p: Promise<StreamParser<unknown>>): Promise<Extension> =>
  p.then((parser) => StreamLanguage.define(parser))
const lang = (p: Promise<LanguageSupport>): Promise<Extension> => p

const LANGS: Record<string, Omit<LanguageInfo, 'id'>> = {
  yaml: { label: 'YAML', load: () => lang(import('@codemirror/lang-yaml').then((m) => m.yaml())) },
  json: { label: 'JSON', load: () => lang(import('@codemirror/lang-json').then((m) => m.json())) },
  javascript: {
    label: 'JavaScript',
    load: () => lang(import('@codemirror/lang-javascript').then((m) => m.javascript()))
  },
  typescript: {
    label: 'TypeScript',
    load: () =>
      lang(import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })))
  },
  python: {
    label: 'Python',
    load: () => lang(import('@codemirror/lang-python').then((m) => m.python()))
  },
  markdown: {
    label: 'Markdown',
    load: () => lang(import('@codemirror/lang-markdown').then((m) => m.markdown()))
  },
  xml: { label: 'XML', load: () => lang(import('@codemirror/lang-xml').then((m) => m.xml())) },
  html: { label: 'HTML', load: () => lang(import('@codemirror/lang-html').then((m) => m.html())) },
  css: { label: 'CSS', load: () => lang(import('@codemirror/lang-css').then((m) => m.css())) },
  sql: { label: 'SQL', load: () => lang(import('@codemirror/lang-sql').then((m) => m.sql())) },
  shell: {
    label: 'Shell',
    load: () => legacy(import('@codemirror/legacy-modes/mode/shell').then((m) => m.shell))
  },
  nginx: {
    label: 'Nginx',
    load: () => legacy(import('@codemirror/legacy-modes/mode/nginx').then((m) => m.nginx))
  },
  dockerfile: {
    label: 'Dockerfile',
    load: () => legacy(import('@codemirror/legacy-modes/mode/dockerfile').then((m) => m.dockerFile))
  },
  toml: {
    label: 'TOML',
    load: () => legacy(import('@codemirror/legacy-modes/mode/toml').then((m) => m.toml))
  },
  ini: {
    label: 'INI / properties',
    load: () => legacy(import('@codemirror/legacy-modes/mode/properties').then((m) => m.properties))
  },
  go: {
    label: 'Go',
    load: () => legacy(import('@codemirror/legacy-modes/mode/go').then((m) => m.go))
  },
  rust: {
    label: 'Rust',
    load: () => legacy(import('@codemirror/legacy-modes/mode/rust').then((m) => m.rust))
  },
  ruby: {
    label: 'Ruby',
    load: () => legacy(import('@codemirror/legacy-modes/mode/ruby').then((m) => m.ruby))
  },
  lua: {
    label: 'Lua',
    load: () => legacy(import('@codemirror/legacy-modes/mode/lua').then((m) => m.lua))
  },
  perl: {
    label: 'Perl',
    load: () => legacy(import('@codemirror/legacy-modes/mode/perl').then((m) => m.perl))
  },
  powershell: {
    label: 'PowerShell',
    load: () => legacy(import('@codemirror/legacy-modes/mode/powershell').then((m) => m.powerShell))
  },
  diff: {
    label: 'Diff',
    load: () => legacy(import('@codemirror/legacy-modes/mode/diff').then((m) => m.diff))
  }
}

const BY_EXT: Record<string, string> = {
  yaml: 'yaml',
  yml: 'yaml',
  json: 'json',
  jsonc: 'json',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  md: 'markdown',
  markdown: 'markdown',
  xml: 'xml',
  svg: 'xml',
  plist: 'xml',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'css',
  sql: 'sql',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ksh: 'shell',
  toml: 'toml',
  ini: 'ini',
  cfg: 'ini',
  cnf: 'ini',
  conf: 'ini',
  properties: 'ini',
  env: 'shell',
  service: 'ini',
  timer: 'ini',
  socket: 'ini',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  lua: 'lua',
  pl: 'perl',
  ps1: 'powershell',
  diff: 'diff',
  patch: 'diff'
}

const BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile',
  '.bashrc': 'shell',
  '.bash_profile': 'shell',
  '.profile': 'shell',
  '.zshrc': 'shell',
  '.env': 'shell',
  'nginx.conf': 'nginx',
  '.gitconfig': 'ini',
  'my.cnf': 'ini',
  crontab: 'shell'
}

/** Ngôn ngữ của file theo tên / đường dẫn (null = văn bản thường). */
export function languageOf(path: string): LanguageInfo | null {
  const name = (path.split('/').pop() ?? path).toLowerCase()
  const dir = path.toLowerCase()
  const ext = name.includes('.') ? (name.split('.').pop() ?? '') : ''
  let id = BY_NAME[name]
  if (!id && name.startsWith('.env')) id = 'shell'
  if (!id && name.startsWith('dockerfile')) id = 'dockerfile'
  // File .conf trong thư mục nginx → cú pháp nginx.
  if (!id && ext === 'conf' && /\/nginx\/|nginx/.test(dir)) id = 'nginx'
  if (!id) id = BY_EXT[ext]
  if (!id) return null
  const info = LANGS[id]
  return info ? { id, ...info } : null
}

/** Mọi ngôn ngữ (đổi tay trong editor). */
export function allLanguages(): LanguageInfo[] {
  return Object.entries(LANGS)
    .map(([id, info]) => ({ id, ...info }))
    .sort((a, b) => a.label.localeCompare(b.label))
}
