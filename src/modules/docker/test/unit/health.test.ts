import { describe, expect, it } from 'vitest'
import { cleanHealthOutput, healthCommand, healthSummary, netRates } from '../../shared/health'

/** Output thật của `curl` trong health check (thanh tiến trình ra stderr, nối với body). */
const CURL_OK = [
  '  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current',
  '                                 Dload  Upload   Total   Spent    Left  Speed',
  '\r  0     0    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0\r100    69  100    69    0     0   7055      0 --:--:-- --:--:-- --:--:--  7666',
  '{"status":"ok","service":"core-api","dependencies":{"database":"ok"}}'
].join('\n')
/** Body nằm giữa hai dòng số liệu (curl in tiến trình sau khi đã ghi body). */
const CURL_MIXED =
  '  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current\n                                 Dload  Upload   Total   Spent    Left  Speed\n  0     0    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0100{"status":"ok","service":"core-api"}    69  100    69    0     0   8957      0 --:--:-- --:--:-- --:--:--  8957'

describe('health check của container', () => {
  it('bỏ thanh tiến trình curl, giữ nội dung thật', () => {
    expect(cleanHealthOutput(CURL_OK)).toBe(
      '{"status":"ok","service":"core-api","dependencies":{"database":"ok"}}'
    )
    expect(cleanHealthOutput(CURL_MIXED)).toBe('{"status":"ok","service":"core-api"}')
    expect(
      cleanHealthOutput(
        "curl: (7) Failed to connect to localhost port 8000 after 0 ms: Couldn't connect to server"
      )
    ).toContain('Failed to connect')
    expect(cleanHealthOutput('Connecting to localhost:8080 (127.0.0.1:8080)\nOK')).toBe('OK')
    expect(cleanHealthOutput('  \n\r ')).toBe('')
  })

  it('lệnh, nhịp, lần lỗi gần nhất; không có health check → null', () => {
    expect(healthCommand(['CMD-SHELL', 'curl -f http://localhost:8000/health'])).toBe(
      'curl -f http://localhost:8000/health'
    )
    expect(healthCommand(['CMD', 'pg_isready', '-U', 'app'])).toBe('pg_isready -U app')
    expect(healthCommand(['NONE'])).toBe('')
    const h = healthSummary({
      State: {
        Health: {
          Status: 'healthy',
          FailingStreak: 0,
          Log: [
            { Start: '2026-10-07T10:13:18Z', ExitCode: 1, Output: 'curl: (7) refused' },
            { Start: '2026-10-07T10:13:48Z', ExitCode: 0, Output: CURL_OK }
          ]
        }
      },
      Config: {
        Healthcheck: {
          Test: ['CMD-SHELL', 'curl -f localhost:8000/health'],
          Interval: 30_000_000_000,
          Retries: 5
        }
      }
    })
    expect(h).toMatchObject({
      status: 'healthy',
      command: 'curl -f localhost:8000/health',
      intervalMs: 30_000,
      timeoutMs: 30_000,
      retries: 5
    })
    expect(h?.runs.map((r) => r.exitCode)).toEqual([0, 1])
    expect(h?.lastFailure?.output).toBe('curl: (7) refused')
    expect(healthSummary({ State: { Status: 'running' } })).toBeNull()
  })

  it('tốc độ mạng từ bộ đếm cộng dồn; container khởi động lại (bộ đếm lùi) → 0', () => {
    expect(
      netRates([
        { at: 0, netRx: 1000, netTx: 0 },
        { at: 2000, netRx: 5000, netTx: 1000 },
        { at: 4000, netRx: 100, netTx: 1000 }
      ])
    ).toEqual([
      { rx: 0, tx: 0 },
      { rx: 2000, tx: 500 },
      { rx: 0, tx: 0 }
    ])
  })
})
