// @vitest-environment jsdom
import './ds-dom'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  Badge,
  EnvLabel,
  Meter,
  ProblemChip,
  StatusChip,
  StatusText
} from '../../src/renderer/src/ds/Status'
import { Toast } from '../../src/renderer/src/ds/Feedback'

/** Quy tắc màu theo ngữ nghĩa (prototype v0.3 — màu của v0.1). */
describe('DS: màu trạng thái theo nghĩa', () => {
  it('StatusText: chấm + chữ cùng màu (ok xanh lá, progress xanh dương, off xám)', () => {
    const { container } = render(
      <>
        <StatusText tone="ok">Running</StatusText>
        <StatusText tone="progress">ContainerCreating</StatusText>
        <StatusText tone="warning">Pending</StatusText>
        <StatusText tone="danger">CrashLoopBackOff</StatusText>
        <StatusText tone="off">Completed</StatusText>
      </>
    )
    const [ok, progress, warning, danger, off] = Array.from(container.children)
    expect(ok?.className).toContain('text-ds-success')
    expect(ok?.querySelector('span')?.className).toContain('bg-ds-success')
    expect(progress?.className).toContain('text-ds-info')
    expect(warning?.className).toContain('text-ds-warning')
    expect(danger?.className).toContain('text-ds-danger')
    expect(off?.className).toContain('text-ds-fg-2')
    // Off là vòng rỗng (không chỉ dựa vào màu).
    expect(off?.querySelector('span')?.className).toContain('bg-transparent')
  })

  it('chip: mọi tông cùng một hình dạng (cao 20px, bo 4px, không viền)', () => {
    render(
      <>
        <StatusChip tone="ok">Running</StatusChip>
        <ProblemChip>CrashLoop</ProblemChip>
        <Badge tone="warning">1 pending</Badge>
      </>
    )
    const ok = screen.getByText('Running')
    const problem = screen.getByText('CrashLoop')
    const badge = screen.getByText('1 pending')
    expect(ok.className).toContain('bg-ds-success-soft')
    expect(problem.className).toContain('bg-ds-danger-soft')
    expect(badge.className).toContain('bg-ds-warning-soft')
    for (const el of [ok, problem, badge]) {
      expect(el.className).toContain('h-5')
      expect(el.className).toContain('rounded-ds-sm')
      expect(el.className).not.toMatch(/(^|\s)border(\s|$)/)
    }
  })

  it('môi trường: ô vuông; chỉ PROD có màu (magenta), STG / DEV / TEST trung tính', () => {
    render(
      <>
        <EnvLabel env="prod" />
        <EnvLabel env="staging" />
        <EnvLabel env="dev" />
        <EnvLabel env="test" />
      </>
    )
    expect(screen.getByRole('img', { name: 'Production' }).className).toContain('text-ds-env-prod')
    for (const name of ['Staging', 'Development', 'Test']) {
      const el = screen.getByRole('img', { name })
      expect(el.className).toContain('text-ds-env-other')
      expect(el.className).not.toContain('ds-env-prod')
    }
    expect(screen.getByText('Stg')).toBeTruthy()
    const { container } = render(<EnvLabel env="dev" dot />)
    const dot = container.firstElementChild
    expect(dot?.className).toContain('rounded-[1px]')
    expect(dot?.className).toContain('bg-ds-fg-3')
  })

  it('meter: xanh dương (chuỗi 2 tím), vàng ≥ 75%, đỏ ≥ 90%', () => {
    const fill = (value: number, series?: 1 | 2): string => {
      const { container } = render(<Meter value={value} label="CPU" series={series} />)
      return container.querySelector('[role="meter"] > span')?.className ?? ''
    }
    expect(fill(0.4)).toContain('bg-ds-chart')
    expect(fill(0.4, 2)).toContain('bg-ds-chart-2')
    expect(fill(0.8)).toContain('bg-ds-warning')
    expect(fill(0.95, 2)).toContain('bg-ds-danger')
  })

  it('toast: icon thành công xanh lá, thông tin xanh dương', () => {
    render(
      <>
        <Toast tone="success" title="Saved" onClose={() => undefined} duration={0} />
        <Toast tone="info" title="Pulling" onClose={() => undefined} duration={0} />
      </>
    )
    const icon = (title: string): string =>
      screen.getByText(title).closest('[role="status"]')?.firstElementChild?.className ?? ''
    expect(icon('Saved')).toContain('text-ds-success')
    expect(icon('Pulling')).toContain('text-ds-info')
  })
})
