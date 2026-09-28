import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { VaultGate } from './components/VaultGate'
import { installTestHooks } from './test-hooks'
import './styles.css'
// Áp theme sáng/tối lên <html> ngay khi có cài đặt.
import './stores/appearance'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root')

void window.shellhouse.getInfo().then((info) => {
  if (info.testHooks) installTestHooks()
  createRoot(root).render(
    <StrictMode>
      <VaultGate>
        <App />
      </VaultGate>
    </StrictMode>
  )
})
