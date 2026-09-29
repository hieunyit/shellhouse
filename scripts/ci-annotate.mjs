// Khi một bước CI thất bại: đưa phần cuối log thành annotation lỗi của GitHub (đọc được trên trang
// Actions / qua API công khai mà không cần tải log). Chạy: node scripts/ci-annotate.mjs <log> [tên]
import { existsSync, readFileSync } from 'node:fs'

const [file, title = 'Failure'] = process.argv.slice(2)
if (!file || !existsSync(file)) process.exit(0)
const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const lines = readFileSync(file, 'utf8').replace(ansi, '').split(/\r?\n/)
// Ưu tiên các dòng báo lỗi; nếu không có thì lấy phần cuối log.
const interesting = lines.filter((l) =>
  /FAIL|✘|×|Error|error:|Unhandled|expected|Received|Timeout|failed/i.test(l)
)
const chosen = (interesting.length > 0 ? interesting : lines).slice(-80).join('\n')
const escape = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
// Annotation tối đa ~64 KB; chia nhỏ để không bị cắt.
for (let i = 0; i < chosen.length; i += 30_000)
  console.log(`::error title=${title}::${escape(chosen.slice(i, i + 30_000))}`)
