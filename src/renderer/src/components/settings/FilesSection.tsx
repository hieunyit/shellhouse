import { FolderOpen } from 'lucide-react'
import { t } from '@shared/i18n'
import { useSettings } from '../../stores/settings'
import { Button, Checkbox, Field, Input, Notice, SectionTitle, Select } from '../ui'

export function FilesSection(): React.JSX.Element {
  const { settings, update } = useSettings()
  const files = settings.files
  const { editor, doubleClick } = files
  const logging = settings.logging

  return (
    <div className="flex flex-col gap-4" data-testid="settings-files">
      <SectionTitle
        description={t(
          'Editing files on a server opens a local copy; every save is uploaded back.'
        )}
      >
        {t('Remote files')}
      </SectionTitle>
      <Checkbox
        label={t('Edit text files in Shellhouse')}
        description={t(
          'Opens config files, scripts and other text in an editor tab with syntax highlighting; Ctrl+S saves straight to the server. Binary and very large files still open in the editor below.'
        )}
        data-testid="setting-editor-in-app"
        checked={files.inApp}
        onChange={(e) => void update({ files: { inApp: e.target.checked } })}
      />
      <Field
        label={t('External editor')}
        hint={t(
          'Pick a program with Choose…, or keep the system default (the app your system opens the file type with).'
        )}
      >
        <div className="flex gap-2">
          <Input
            mono
            readOnly
            className="min-w-0 flex-1"
            data-testid="setting-editor"
            placeholder={t('System default')}
            value={editor}
          />
          <Button
            data-testid="setting-editor-choose"
            onClick={() =>
              // Main mở hộp thoại và tự lưu — renderer không đặt đường dẫn chương trình.
              void window.shellhouse.chooseEditor().then((next) => {
                if (next) useSettings.setState({ settings: next, loaded: true })
              })
            }
          >
            {t('Choose…')}
          </Button>
          {editor && (
            <Button
              variant="ghost"
              data-testid="setting-editor-reset"
              onClick={() =>
                void window.shellhouse.resetEditor().then((next) => {
                  useSettings.setState({ settings: next, loaded: true })
                })
              }
            >
              {t('Use system default')}
            </Button>
          )}
        </div>
      </Field>
      <Field label={t('Double-click a file in SFTP')}>
        <Select
          className="w-64"
          data-testid="setting-sftp-double-click"
          value={doubleClick}
          onChange={(e) =>
            void update({ files: { doubleClick: e.target.value as 'edit' | 'download' } })
          }
        >
          <option value="edit">{t('Open in editor')}</option>
          <option value="download">{t('Download')}</option>
        </Select>
      </Field>

      <SectionTitle
        description={t(
          'How many SFTP requests run at the same time. Higher is faster on fast links and big folders; lower is gentler on small servers. Applies to newly opened tabs. S3 has its own settings in Modules.'
        )}
      >
        {t('Transfers & performance')}
      </SectionTitle>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label={t('SFTP parallel requests')}
          hint={t('Browsing, creating and deleting folders')}
        >
          <Select
            data-testid="setting-sftp-requests"
            value={String(files.sftpRequests)}
            onChange={(e) => void update({ files: { sftpRequests: Number(e.target.value) } })}
          >
            {[2, 4, 8, 12, 16].map((n) => (
              <option key={n} value={n}>
                {n === 8 ? t('{n} (default)', { n }) : n}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={t('SFTP files at once')}
          hint={t('Each file is also sent in pipelined chunks')}
        >
          <Select
            data-testid="setting-sftp-transfers"
            value={String(files.sftpTransfers)}
            onChange={(e) => void update({ files: { sftpTransfers: Number(e.target.value) } })}
          >
            {[1, 2, 3, 4, 6, 8].map((n) => (
              <option key={n} value={n}>
                {n === 4 ? t('{n} (default)', { n }) : n}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <SectionTitle
        description={t('Save everything a session prints to a text file, one folder per host.')}
      >
        {t('Session logs')}
      </SectionTitle>
      <Field label={t('Record sessions')}>
        <Select
          className="w-64"
          data-testid="setting-logging-mode"
          value={logging.mode}
          onChange={(e) =>
            void update({ logging: { mode: e.target.value as 'off' | 'ssh' | 'all' } })
          }
        >
          <option value="off">{t('Off')}</option>
          <option value="ssh">{t('SSH sessions')}</option>
          <option value="all">{t('All sessions (SSH and local)')}</option>
        </Select>
      </Field>
      <Field label={t('Folder')} hint={t('New sessions use the new folder.')}>
        <div className="flex gap-2">
          <Input
            mono
            readOnly
            className="min-w-0 flex-1"
            data-testid="setting-logging-directory"
            placeholder="Documents/Shellhouse logs"
            value={logging.directory}
          />
          <Button
            data-testid="choose-log-folder"
            onClick={() => void window.shellhouse.chooseLogFolder()}
          >
            {t('Choose…')}
          </Button>
          <Button
            variant="ghost"
            icon={<FolderOpen size={13} />}
            data-testid="open-log-folder"
            onClick={() => void window.shellhouse.openLogFolder()}
          >
            {t('Open')}
          </Button>
        </div>
      </Field>
      <Checkbox
        label={t('Plain text (remove colors and terminal control codes)')}
        checked={logging.stripAnsi}
        onChange={(e) => void update({ logging: { stripAnsi: e.target.checked } })}
      />
      {logging.mode !== 'off' && (
        <Notice tone="warning" testId="logging-warning">
          {t(
            'Logs contain everything shown in the terminal, including secrets printed on screen. They are stored unencrypted.'
          )}
        </Notice>
      )}
    </div>
  )
}
