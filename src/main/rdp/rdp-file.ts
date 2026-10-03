import {
  DEFAULT_RDP,
  hostPort,
  RDP_DEFAULT_PORT,
  RDP_SCALES,
  RdpSettings,
  splitDomainUser,
  type RdpSettings as RdpSettingsType
} from '@shared/rdp'

/**
 * Đích mà client RDP sẽ kết nối (sau khi đã thay bằng 127.0.0.1:<cổng tunnel> nếu đi qua SSH).
 * KHÔNG có mật khẩu — mật khẩu không bao giờ được ghi vào file.
 */
export interface RdpTarget {
  label: string
  host: string
  port: number
  username: string
  domain: string
  settings: RdpSettingsType
}

/** Giá trị đi vào file cấu hình: một dòng, không ký tự điều khiển (chống chèn thêm dòng cấu hình). */
function clean(value: string): string {
  // eslint-disable-next-line no-control-regex -- kiểm đúng ký tự điều khiển
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid character in RDP setting')
  return value
}

/** Tên hiển thị: thay ký tự điều khiển bằng khoảng trắng (tên host do người dùng đặt). */
function safeLabel(label: string): string {
  // eslint-disable-next-line no-control-regex -- thay đúng ký tự điều khiển
  return label.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 100)
}

/** "CORP\john" (mstsc / cmdkey) hoặc "john". */
export function qualifiedUser(username: string, domain: string): string {
  return domain ? `${domain}\\${username}` : username
}

/**
 * Nội dung file .rdp cho mstsc (Windows) và Windows App / Microsoft Remote Desktop (macOS).
 * Không bao giờ có dòng "password 51:b:" — mstsc lấy mật khẩu từ Credential Manager (cmdkey).
 */
export function buildRdpFile(target: RdpTarget): string {
  const s = target.settings
  const lines: [string, 'i' | 's', string | number][] = [
    ['full address', 's', hostPort(target.host, target.port)],
    ['screen mode id', 'i', s.fullScreen ? 2 : 1],
    ['use multimon', 'i', s.fullScreen && s.multiMonitor ? 1 : 0],
    ['desktopwidth', 'i', s.width],
    ['desktopheight', 'i', s.height],
    ['dynamic resolution', 'i', s.dynamicResolution ? 1 : 0],
    // Không đổi độ phân giải theo cửa sổ thì co giãn hình cho vừa cửa sổ.
    ['smart sizing', 'i', s.dynamicResolution ? 0 : 1]
  ]
  if (s.scale !== null) {
    lines.push(['desktopscalefactor', 'i', s.scale], ['devicescalefactor', 'i', 100])
  }
  lines.push(
    ['redirectclipboard', 'i', s.clipboard ? 1 : 0],
    ['drivestoredirect', 's', s.drives ? '*' : ''],
    ['audiomode', 'i', s.audio ? 0 : 2],
    ['redirectprinters', 'i', s.printers ? 1 : 0],
    ['autoreconnection enabled', 'i', 1],
    // Cảnh báo (không chặn) khi không xác minh được chứng chỉ — tunnel 127.0.0.1 luôn lệch tên.
    ['authentication level', 'i', 2],
    ['prompt for credentials', 'i', 0],
    ['promptcredentialonce', 'i', 1]
  )
  if (target.username) lines.push(['username', 's', qualifiedUser(target.username, target.domain)])
  if (target.domain) lines.push(['domain', 's', target.domain])
  if (s.gateway) {
    lines.push(
      ['gatewayhostname', 's', s.gateway],
      ['gatewayusagemethod', 'i', 1],
      ['gatewayprofileusagemethod', 'i', 1],
      ['gatewaycredentialssource', 'i', 4]
    )
  } else {
    lines.push(['gatewayusagemethod', 'i', 0])
  }
  return lines.map(([k, type, v]) => `${k}:${type}:${clean(String(v))}`).join('\r\n') + '\r\n'
}

/** mstsc ghi .rdp dạng UTF-16LE có BOM — đọc được tên người dùng có dấu. */
export function encodeRdpFile(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
}

/** File .remmina (INI) cho Remmina — không có mật khẩu (Remmina tự hỏi). */
export function buildRemminaFile(target: RdpTarget, home: string): string {
  const s = target.settings
  const entries: [string, string | number][] = [
    ['name', safeLabel(target.label)],
    ['protocol', 'RDP'],
    ['server', hostPort(target.host, target.port)],
    ['username', target.username],
    ['domain', target.domain],
    // 1 = cửa sổ, 4 = toàn màn hình.
    ['viewmode', s.fullScreen ? 4 : 1],
    ['resolution_mode', 2],
    ['resolution_width', s.width],
    ['resolution_height', s.height],
    ['multimon', s.fullScreen && s.multiMonitor ? 1 : 0],
    ['dynamic_resolution_width', s.dynamicResolution ? s.width : 0],
    ['disableclipboard', s.clipboard ? 0 : 1],
    ['sharefolder', s.drives ? home : ''],
    ['shareprinter', s.printers ? 1 : 0],
    ['sound', s.audio ? 'local' : 'off'],
    ['cert_ignore', 0]
  ]
  if (s.gateway) entries.push(['gateway_server', s.gateway], ['gateway_usage', 1])
  return '[remmina]\n' + entries.map(([k, v]) => `${k}=${clean(String(v))}`).join('\n') + '\n'
}

/** Một host đọc được từ file .rdp (Import). */
export interface ParsedRdpFile {
  hostname: string
  port: number
  username: string
  settings: RdpSettingsType
}

/** Giải mã file .rdp: UTF-16LE (có BOM, như mstsc lưu) hoặc UTF-8. */
export function decodeRdpFile(data: Buffer): string {
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe)
    return data.subarray(2).toString('utf16le')
  const text = data.toString('utf8')
  return text.startsWith('﻿') ? text.slice(1) : text
}

/** "host", "host:3390", "[::1]:3390", "::1" → host + cổng. */
export function parseAddress(raw: string): { host: string; port: number } | null {
  const text = raw.trim()
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(text)
  if (bracket) return { host: bracket[1] ?? '', port: Number(bracket[2] ?? RDP_DEFAULT_PORT) }
  const parts = text.split(':')
  if (parts.length === 2 && /^\d+$/.test(parts[1] ?? ''))
    return { host: parts[0] ?? '', port: Number(parts[1]) }
  if (parts.length > 2) return { host: text, port: RDP_DEFAULT_PORT } // IPv6 không có cổng
  return text ? { host: text, port: RDP_DEFAULT_PORT } : null
}

/**
 * Đọc các trường phổ biến của file .rdp (full address, username, domain, màn hình, chuyển hướng,
 * gateway). Trường lạ bị bỏ qua; "password 51:b:" (DPAPI, chỉ giải mã được trên máy tạo) bỏ qua.
 */
export function parseRdpFile(text: string): ParsedRdpFile | null {
  const values = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const m = /^([^:]+):([isb]):(.*)$/.exec(line.trim())
    if (m) values.set((m[1] ?? '').trim().toLowerCase(), (m[3] ?? '').trim())
  }
  const address = parseAddress(
    values.get('full address') ?? values.get('alternate full address') ?? ''
  )
  if (!address || !address.host) return null
  const serverPort = Number(values.get('server port'))
  const port =
    address.port === RDP_DEFAULT_PORT && Number.isInteger(serverPort) && serverPort > 0
      ? serverPort
      : address.port
  const int = (key: string): number | null => {
    const v = values.get(key)
    return v !== undefined && /^-?\d+$/.test(v) ? Number(v) : null
  }
  const split = splitDomainUser(values.get('username') ?? '')
  const scale = int('desktopscalefactor')
  const gatewayUsage = int('gatewayusagemethod')
  const gateway = values.get('gatewayhostname') ?? ''
  const draft: RdpSettingsType = {
    ...DEFAULT_RDP,
    domain: values.get('domain') || split.domain || '',
    fullScreen: int('screen mode id') === 2,
    width: int('desktopwidth') ?? DEFAULT_RDP.width,
    height: int('desktopheight') ?? DEFAULT_RDP.height,
    multiMonitor: int('use multimon') === 1,
    dynamicResolution: int('dynamic resolution') !== 0,
    scale: (RDP_SCALES as readonly number[]).includes(scale ?? 0)
      ? (scale as RdpSettingsType['scale'])
      : null,
    clipboard: int('redirectclipboard') !== 0,
    drives: (values.get('drivestoredirect') ?? '') !== '',
    audio: (int('audiomode') ?? 0) === 0,
    printers: int('redirectprinters') === 1,
    gateway: gateway && gatewayUsage !== 0 && gatewayUsage !== 4 ? gateway : null
  }
  // Giá trị lạ (độ phân giải 0, domain có ký tự cấm…) → bỏ dần các trường đó thay vì bỏ cả file.
  const attempts: RdpSettingsType[] = [
    draft,
    { ...draft, width: DEFAULT_RDP.width, height: DEFAULT_RDP.height },
    { ...draft, width: DEFAULT_RDP.width, height: DEFAULT_RDP.height, domain: '', gateway: null }
  ]
  const settings =
    attempts.map((a) => RdpSettings.safeParse(a)).find((r) => r.success)?.data ?? DEFAULT_RDP
  return { hostname: address.host, port, username: split.username, settings }
}
