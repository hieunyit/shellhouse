import type { TerminalTheme } from './settings'

type Colors = TerminalTheme['colors']

const ansi = (
  list: [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string
  ]
): Pick<
  Colors,
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'brightBlack'
  | 'brightRed'
  | 'brightGreen'
  | 'brightYellow'
  | 'brightBlue'
  | 'brightMagenta'
  | 'brightCyan'
  | 'brightWhite'
> => ({
  black: list[0],
  red: list[1],
  green: list[2],
  yellow: list[3],
  blue: list[4],
  magenta: list[5],
  cyan: list[6],
  white: list[7],
  brightBlack: list[8],
  brightRed: list[9],
  brightGreen: list[10],
  brightYellow: list[11],
  brightBlue: list[12],
  brightMagenta: list[13],
  brightCyan: list[14],
  brightWhite: list[15]
})

export const BUILTIN_THEMES: readonly TerminalTheme[] = [
  {
    id: 'shellhouse-dark',
    name: 'Shellhouse Dark',
    dark: true,
    colors: {
      background: '#0f1115',
      foreground: '#e6e8eb',
      cursor: '#e6e8eb',
      selectionBackground: '#3b4252',
      ...ansi([
        '#1d2027',
        '#f7768e',
        '#9ece6a',
        '#e0af68',
        '#7aa2f7',
        '#bb9af7',
        '#7dcfff',
        '#c0caf5',
        '#414868',
        '#ff8fa3',
        '#b9f27c',
        '#ffc777',
        '#8fb3ff',
        '#c7a9ff',
        '#a4daff',
        '#ffffff'
      ])
    }
  },
  {
    id: 'shellhouse-light',
    name: 'Shellhouse Light',
    dark: false,
    colors: {
      background: '#fbfbfc',
      foreground: '#1f2328',
      cursor: '#1f2328',
      selectionBackground: '#cde2ff',
      ...ansi([
        '#24292f',
        '#cf222e',
        '#116329',
        '#7d4e00',
        '#0550ae',
        '#8250df',
        '#1b7c83',
        '#6e7781',
        '#57606a',
        '#a40e26',
        '#1a7f37',
        '#633c01',
        '#218bff',
        '#a475f9',
        '#3192aa',
        '#8c959f'
      ])
    }
  },
  {
    id: 'solarized-dark',
    name: 'Solarized Dark',
    dark: true,
    colors: {
      background: '#002b36',
      foreground: '#839496',
      cursor: '#93a1a1',
      selectionBackground: '#073642',
      ...ansi([
        '#073642',
        '#dc322f',
        '#859900',
        '#b58900',
        '#268bd2',
        '#d33682',
        '#2aa198',
        '#eee8d5',
        '#002b36',
        '#cb4b16',
        '#586e75',
        '#657b83',
        '#839496',
        '#6c71c4',
        '#93a1a1',
        '#fdf6e3'
      ])
    }
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    dark: false,
    colors: {
      background: '#fdf6e3',
      foreground: '#657b83',
      cursor: '#586e75',
      selectionBackground: '#eee8d5',
      ...ansi([
        '#073642',
        '#dc322f',
        '#859900',
        '#b58900',
        '#268bd2',
        '#d33682',
        '#2aa198',
        '#eee8d5',
        '#002b36',
        '#cb4b16',
        '#586e75',
        '#657b83',
        '#839496',
        '#6c71c4',
        '#93a1a1',
        '#fdf6e3'
      ])
    }
  },
  {
    id: 'dracula',
    name: 'Dracula',
    dark: true,
    colors: {
      background: '#282a36',
      foreground: '#f8f8f2',
      cursor: '#f8f8f2',
      selectionBackground: '#44475a',
      ...ansi([
        '#21222c',
        '#ff5555',
        '#50fa7b',
        '#f1fa8c',
        '#bd93f9',
        '#ff79c6',
        '#8be9fd',
        '#f8f8f2',
        '#6272a4',
        '#ff6e6e',
        '#69ff94',
        '#ffffa5',
        '#d6acff',
        '#ff92df',
        '#a4ffff',
        '#ffffff'
      ])
    }
  },
  {
    id: 'nord',
    name: 'Nord',
    dark: true,
    colors: {
      background: '#2e3440',
      foreground: '#d8dee9',
      cursor: '#d8dee9',
      selectionBackground: '#434c5e',
      ...ansi([
        '#3b4252',
        '#bf616a',
        '#a3be8c',
        '#ebcb8b',
        '#81a1c1',
        '#b48ead',
        '#88c0d0',
        '#e5e9f0',
        '#4c566a',
        '#bf616a',
        '#a3be8c',
        '#ebcb8b',
        '#81a1c1',
        '#b48ead',
        '#8fbcbb',
        '#eceff4'
      ])
    }
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    dark: true,
    colors: {
      background: '#282c34',
      foreground: '#abb2bf',
      cursor: '#528bff',
      selectionBackground: '#3e4451',
      ...ansi([
        '#282c34',
        '#e06c75',
        '#98c379',
        '#e5c07b',
        '#61afef',
        '#c678dd',
        '#56b6c2',
        '#abb2bf',
        '#5c6370',
        '#e06c75',
        '#98c379',
        '#e5c07b',
        '#61afef',
        '#c678dd',
        '#56b6c2',
        '#ffffff'
      ])
    }
  },
  {
    id: 'monokai',
    name: 'Monokai',
    dark: true,
    colors: {
      background: '#272822',
      foreground: '#f8f8f2',
      cursor: '#f8f8f0',
      selectionBackground: '#49483e',
      ...ansi([
        '#272822',
        '#f92672',
        '#a6e22e',
        '#f4bf75',
        '#66d9ef',
        '#ae81ff',
        '#a1efe4',
        '#f8f8f2',
        '#75715e',
        '#f92672',
        '#a6e22e',
        '#f4bf75',
        '#66d9ef',
        '#ae81ff',
        '#a1efe4',
        '#f9f8f5'
      ])
    }
  },
  {
    id: 'gruvbox-dark',
    name: 'Gruvbox Dark',
    dark: true,
    colors: {
      background: '#282828',
      foreground: '#ebdbb2',
      cursor: '#ebdbb2',
      selectionBackground: '#504945',
      ...ansi([
        '#282828',
        '#cc241d',
        '#98971a',
        '#d79921',
        '#458588',
        '#b16286',
        '#689d6a',
        '#a89984',
        '#928374',
        '#fb4934',
        '#b8bb26',
        '#fabd2f',
        '#83a598',
        '#d3869b',
        '#8ec07c',
        '#ebdbb2'
      ])
    }
  },
  {
    id: 'gruvbox-light',
    name: 'Gruvbox Light',
    dark: false,
    colors: {
      background: '#fbf1c7',
      foreground: '#3c3836',
      cursor: '#3c3836',
      selectionBackground: '#d5c4a1',
      ...ansi([
        '#fbf1c7',
        '#cc241d',
        '#98971a',
        '#d79921',
        '#458588',
        '#b16286',
        '#689d6a',
        '#7c6f64',
        '#928374',
        '#9d0006',
        '#79740e',
        '#b57614',
        '#076678',
        '#8f3f71',
        '#427b58',
        '#3c3836'
      ])
    }
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    dark: true,
    colors: {
      background: '#1a1b26',
      foreground: '#c0caf5',
      cursor: '#c0caf5',
      selectionBackground: '#33467c',
      ...ansi([
        '#15161e',
        '#f7768e',
        '#9ece6a',
        '#e0af68',
        '#7aa2f7',
        '#bb9af7',
        '#7dcfff',
        '#a9b1d6',
        '#414868',
        '#f7768e',
        '#9ece6a',
        '#e0af68',
        '#7aa2f7',
        '#bb9af7',
        '#7dcfff',
        '#c0caf5'
      ])
    }
  },
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    dark: true,
    colors: {
      background: '#1e1e2e',
      foreground: '#cdd6f4',
      cursor: '#f5e0dc',
      selectionBackground: '#45475a',
      ...ansi([
        '#45475a',
        '#f38ba8',
        '#a6e3a1',
        '#f9e2af',
        '#89b4fa',
        '#f5c2e7',
        '#94e2d5',
        '#bac2de',
        '#585b70',
        '#f38ba8',
        '#a6e3a1',
        '#f9e2af',
        '#89b4fa',
        '#f5c2e7',
        '#94e2d5',
        '#a6adc8'
      ])
    }
  },
  {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    dark: false,
    colors: {
      background: '#eff1f5',
      foreground: '#4c4f69',
      cursor: '#dc8a78',
      selectionBackground: '#ccd0da',
      ...ansi([
        '#5c5f77',
        '#d20f39',
        '#40a02b',
        '#df8e1d',
        '#1e66f5',
        '#ea76cb',
        '#179299',
        '#acb0be',
        '#6c6f85',
        '#d20f39',
        '#40a02b',
        '#df8e1d',
        '#1e66f5',
        '#ea76cb',
        '#179299',
        '#bcc0cc'
      ])
    }
  },
  {
    id: 'github-dark',
    name: 'GitHub Dark',
    dark: true,
    colors: {
      background: '#0d1117',
      foreground: '#e6edf3',
      cursor: '#e6edf3',
      selectionBackground: '#264f78',
      ...ansi([
        '#484f58',
        '#ff7b72',
        '#3fb950',
        '#d29922',
        '#58a6ff',
        '#bc8cff',
        '#39c5cf',
        '#b1bac4',
        '#6e7681',
        '#ffa198',
        '#56d364',
        '#e3b341',
        '#79c0ff',
        '#d2a8ff',
        '#56d4dd',
        '#ffffff'
      ])
    }
  },
  {
    id: 'github-light',
    name: 'GitHub Light',
    dark: false,
    colors: {
      background: '#ffffff',
      foreground: '#1f2328',
      cursor: '#1f2328',
      selectionBackground: '#add6ff',
      ...ansi([
        '#24292f',
        '#cf222e',
        '#116329',
        '#4d2d00',
        '#0969da',
        '#8250df',
        '#1b7c83',
        '#6e7781',
        '#57606a',
        '#a40e26',
        '#1a7f37',
        '#633c01',
        '#218bff',
        '#a475f9',
        '#3192aa',
        '#8c959f'
      ])
    }
  },
  {
    id: 'ayu-dark',
    name: 'Ayu Dark',
    dark: true,
    colors: {
      background: '#0b0e14',
      foreground: '#bfbdb6',
      cursor: '#e6b450',
      selectionBackground: '#273747',
      ...ansi([
        '#1e232b',
        '#ea6c73',
        '#7fd962',
        '#f9af4f',
        '#53bdfa',
        '#cda1fa',
        '#90e1c6',
        '#c7c7c7',
        '#686868',
        '#f07178',
        '#aad94c',
        '#ffb454',
        '#59c2ff',
        '#d2a6ff',
        '#95e6cb',
        '#ffffff'
      ])
    }
  },
  {
    id: 'night-owl',
    name: 'Night Owl',
    dark: true,
    colors: {
      background: '#011627',
      foreground: '#d6deeb',
      cursor: '#80a4c2',
      selectionBackground: '#1d3b53',
      ...ansi([
        '#011627',
        '#ef5350',
        '#22da6e',
        '#c5e478',
        '#82aaff',
        '#c792ea',
        '#21c7a8',
        '#ffffff',
        '#575656',
        '#ef5350',
        '#22da6e',
        '#ffeb95',
        '#82aaff',
        '#c792ea',
        '#7fdbca',
        '#ffffff'
      ])
    }
  },
  {
    id: 'material',
    name: 'Material',
    dark: true,
    colors: {
      background: '#263238',
      foreground: '#eeffff',
      cursor: '#ffcc00',
      selectionBackground: '#546e7a',
      ...ansi([
        '#000000',
        '#e53935',
        '#91b859',
        '#ffb62c',
        '#6182b8',
        '#7c4dff',
        '#39adb5',
        '#ffffff',
        '#546e7a',
        '#ff5370',
        '#c3e88d',
        '#ffcb6b',
        '#82aaff',
        '#c792ea',
        '#89ddff',
        '#ffffff'
      ])
    }
  }
]

const HEX = /^#[0-9a-fA-F]{6}$/

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number
  ]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function slug(name: string): string {
  return `custom-${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'theme'
  }`
}

/** Màu vùng chọn khi file theme không có: tối trên nền tối, xanh nhạt trên nền sáng. */
export function defaultSelection(background: string): string {
  return luminance(background) < 0.5 ? '#44475a' : '#cde2ff'
}

function finish(name: string, c: Colors): TerminalTheme {
  for (const [key, value] of Object.entries(c)) {
    if (!HEX.test(value)) throw new Error(`Invalid color "${key}": ${value}`)
  }
  return { id: slug(name), name, dark: luminance(c.background) < 0.5, colors: c }
}

/** Scheme của Windows Terminal (một object trong mảng "schemes" của settings.json). */
export function importWindowsTerminal(json: string): TerminalTheme {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(json) as Record<string, unknown>
  } catch {
    throw new Error('Not valid JSON')
  }
  // Cho phép dán cả settings.json: lấy scheme đầu tiên.
  const schemes = data['schemes']
  if (Array.isArray(schemes)) data = (schemes[0] ?? {}) as Record<string, unknown>
  const get = (key: string, fallback?: string): string => {
    const v = data[key]
    if (typeof v === 'string')
      return v.length === 4 ? `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}` : v
    if (fallback !== undefined) return fallback
    throw new Error(`Missing color "${key}"`)
  }
  const background = get('background')
  const foreground = get('foreground')
  return finish(typeof data['name'] === 'string' ? data['name'] : 'Imported', {
    background,
    foreground,
    cursor: get('cursorColor', foreground),
    selectionBackground: get('selectionBackground', defaultSelection(background)),
    black: get('black'),
    red: get('red'),
    green: get('green'),
    yellow: get('yellow'),
    blue: get('blue'),
    magenta: get('purple'),
    cyan: get('cyan'),
    white: get('white'),
    brightBlack: get('brightBlack'),
    brightRed: get('brightRed'),
    brightGreen: get('brightGreen'),
    brightYellow: get('brightYellow'),
    brightBlue: get('brightBlue'),
    brightMagenta: get('brightPurple'),
    brightCyan: get('brightCyan'),
    brightWhite: get('brightWhite')
  })
}

/** File `.itermcolors` (plist XML) của iTerm2. */
export function importItermColors(xml: string, name = 'iTerm2'): TerminalTheme {
  if (xml.length > 200_000) throw new Error('File is too large')
  const color = (key: string, fallback?: string): string => {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const block = new RegExp(`<key>\\s*${escaped}\\s*</key>\\s*<dict>([\\s\\S]*?)</dict>`).exec(
      xml
    )?.[1]
    if (!block) {
      if (fallback !== undefined) return fallback
      throw new Error(`Missing color "${key}"`)
    }
    const component = (c: string): number => {
      const m = new RegExp(
        `<key>\\s*${c} Component\\s*</key>\\s*<real>\\s*([0-9.eE+-]+)\\s*</real>`
      ).exec(block)
      const v = m?.[1] ? Number(m[1]) : NaN
      if (!Number.isFinite(v)) throw new Error(`Color "${key}" is missing its ${c} component`)
      return Math.round(Math.min(1, Math.max(0, v)) * 255)
    }
    return `#${[component('Red'), component('Green'), component('Blue')].map((n) => n.toString(16).padStart(2, '0')).join('')}`
  }
  const a = (n: number): string => color(`Ansi ${n} Color`)
  const foreground = color('Foreground Color')
  const background = color('Background Color')
  return finish(name, {
    background,
    foreground,
    cursor: color('Cursor Color', foreground),
    selectionBackground: color('Selection Color', defaultSelection(background)),
    black: a(0),
    red: a(1),
    green: a(2),
    yellow: a(3),
    blue: a(4),
    magenta: a(5),
    cyan: a(6),
    white: a(7),
    brightBlack: a(8),
    brightRed: a(9),
    brightGreen: a(10),
    brightYellow: a(11),
    brightBlue: a(12),
    brightMagenta: a(13),
    brightCyan: a(14),
    brightWhite: a(15)
  })
}

/** Chọn theme theo cài đặt ('system' → theo chế độ sáng/tối của hệ điều hành). */
export function resolveTheme(
  settings: { themeId: string; darkThemeId: string; lightThemeId: string },
  custom: readonly TerminalTheme[],
  systemDark: boolean
): TerminalTheme {
  const all = [...BUILTIN_THEMES, ...custom]
  const id =
    settings.themeId === 'system'
      ? systemDark
        ? settings.darkThemeId
        : settings.lightThemeId
      : settings.themeId
  return (
    all.find((t) => t.id === id) ??
    ((systemDark || settings.themeId !== 'system'
      ? BUILTIN_THEMES[0]
      : BUILTIN_THEMES[1]) as TerminalTheme)
  )
}
