import { describe, expect, it } from 'vitest'
import {
  CommandHistory,
  looksSecret,
  MAX_COMMANDS_PER_TARGET
} from '../../src/main/command-history'
import { openDatabase } from '../../src/main/store/db'
import { migrate } from '../../src/main/store/migrate'
import { MIGRATIONS } from '../../src/main/store/migrations'

async function setup() {
  const db = openDatabase(':memory:')
  await migrate(db, MIGRATIONS)
  let t = 1000
  return new CommandHistory(db, () => ++t)
}

describe('CommandHistory', () => {
  it('mới nhất trước; gõ lại lệnh cũ thì lên đầu, không trùng; tách theo host', async () => {
    const h = await setup()
    h.record('web', 'ls -la')
    h.record('web', 'systemctl status nginx')
    h.record('db', 'psql')
    h.record('web', 'ls -la')
    expect(h.list('web')).toEqual(['ls -la', 'systemctl status nginx'])
    expect(h.list('db')).toEqual(['psql'])
  })

  it('bỏ lệnh rỗng, nhiều dòng, quá dài', async () => {
    const h = await setup()
    h.record('web', '   ')
    h.record('web', 'echo a\necho b')
    h.record('web', 'x'.repeat(1001))
    expect(h.list('web')).toEqual([])
  })

  it('giới hạn số lệnh mỗi host (bỏ lệnh cũ nhất)', async () => {
    const h = await setup()
    const total = MAX_COMMANDS_PER_TARGET + 101 // vượt ngưỡng dọn (dọn theo đợt 100)
    for (let i = 0; i < total; i++) h.record('web', `cmd-${i}`)
    const list = h.list('web', total)
    expect(list).toHaveLength(MAX_COMMANDS_PER_TARGET)
    expect(list[0]).toBe(`cmd-${total - 1}`)
    expect(list).not.toContain('cmd-0')
  })

  it('xoá một host hoặc tất cả', async () => {
    const h = await setup()
    h.record('web', 'a')
    h.record('db', 'b')
    h.clear('web')
    expect(h.list('web')).toEqual([])
    expect(h.list('db')).toEqual(['b'])
    h.clear(null)
    expect(h.list('db')).toEqual([])
  })

  it('không lưu lệnh có mật khẩu / token trên dòng lệnh', async () => {
    const h = await setup()
    h.record('web', 'mysql -uroot -pS3cret db')
    h.record('web', 'ls -la')
    expect(h.list('web')).toEqual(['ls -la'])
  })
})

describe('looksSecret', () => {
  it.each([
    'mysql -uroot -pS3cret',
    'mysqldump --user=app -phunter2 shop > shop.sql',
    'psql --password=abc',
    'tool --token abcdef',
    'PGPASSWORD=x psql -h db',
    'export GITHUB_TOKEN=ghp_xxx',
    'AWS_SECRET_ACCESS_KEY=abc aws s3 ls',
    'export API_KEY=1',
    'sshpass -p hunter2 ssh u@h',
    'docker login -u me -p hunter2 registry',
    'curl -H "Authorization: Bearer eyJ..." https://api',
    'curl -H "X-Api-Key: k" https://api',
    'curl -u admin:hunter2 https://x',
    'git clone https://user:hunter2@git.example/repo.git',
    'mongo mongodb://app:pw@db:27017/x',
    'DB_PASS=x ./run',
    'MYSQL_PWD=x mysql',
    'docker run -e POSTGRES_PASSWORD=hunter2 postgres',
    'app --client-secret=abc',
    'env clientSecret=abc node app.js',
    'export AWS_ACCESS_KEY_ID=AKIA',
    'echo x | GH_TOKEN=ghp_x gh auth login'
  ])('bắt %s', (command) => {
    expect(looksSecret(command)).toBe(true)
  })

  it.each([
    'ls -la',
    'mysql -uroot -p db',
    'docker login --password-stdin',
    'git push origin main',
    'ssh -p 2222 user@host',
    'grep password /etc/app.conf',
    'passwd',
    'curl https://example.com/a?b=c',
    'systemctl restart nginx',
    'cd /var/www && npm run build',
    'ssh -o PasswordAuthentication=no host',
    'ssh -o PubkeyAuthentication=yes -o PasswordAuthentication=no u@h',
    'docker run -e POSTGRES_PASSWORD_FILE=/run/secrets/pg postgres',
    'export VAULT_TOKEN_PATH=/etc/vault/token',
    'grep -r api_key=foo .',
    'rg "password=" src',
    'tool --bypass-x=1',
    'make TOKENIZER=fast'
  ])('không bắt %s', (command) => {
    expect(looksSecret(command)).toBe(false)
  })
})
