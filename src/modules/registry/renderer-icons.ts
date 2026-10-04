import { createLucideIcon } from 'lucide-react'

/**
 * Icon Kubernetes (thiết kế v0.6): bánh lái 7 cạnh, 7 nan — vẽ theo phong cách nét của lucide (16px,
 * stroke 1.5) để đứng cạnh các icon khác trên activity bar.
 */
export const KubernetesIcon = createLucideIcon('kubernetes', [
  [
    'path',
    {
      d: 'M12.00 2.40 L19.51 6.01 L21.36 14.14 L16.17 20.65 L7.83 20.65 L2.64 14.14 L4.49 6.01 Z',
      key: 'rim'
    }
  ],
  ['circle', { cx: '12', cy: '12', r: '3.2', key: 'hub' }],
  [
    'path',
    {
      d: 'M12.00 8.80 L12.00 5.00 M14.50 10.00 L17.47 7.64 M15.12 12.71 L18.82 13.56 M13.39 14.88 L15.04 18.31 M10.61 14.88 L8.96 18.31 M8.88 12.71 L5.18 13.56 M9.50 10.00 L6.53 7.64',
      key: 'spokes'
    }
  ]
])
