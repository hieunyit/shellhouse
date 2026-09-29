import { FolderOpen } from 'lucide-react'
import { useSettings } from '../../stores/settings'
import { Button, Checkbox, Field, Input, Notice, SectionTitle, Select } from '../ui'

export function FilesSection(): React.JSX.Element {
  const { settings, update } = useSettings()
  const { editor, doubleClick } = settings.files
  const logging = settings.logging

  return (
    <div className="flex flex-col gap-4" data-testid="settings-files">
      <SectionTitle description="Editing files on a server opens a local copy; every save is uploaded back.">
        Remote files
      </SectionTitle>
      <Field label="Editor" hint="Leave empty to use the app your system opens the file type with.">
        <div className="flex gap-2">
          <Input
            mono
            readOnly
            className="min-w-0 flex-1"
            data-testid="setting-editor"
            placeholder="System default"
            value={editor}
          />
          <Button
            data-testid="setting-editor-choose"
            onClick={() =>
              void window.shellhouse.pickProgram().then((program) => {
                if (program) void update({ files: { editor: program } })
              })
            }
          >
            Choose…
          </Button>
          {editor && (
            <Button variant="ghost" onClick={() => void update({ files: { editor: '' } })}>
              Use default
            </Button>
          )}
        </div>
      </Field>
      <Field label="Double-click a file in SFTP">
        <Select
          className="w-64"
          data-testid="setting-sftp-double-click"
          value={doubleClick}
          onChange={(e) =>
            void update({ files: { doubleClick: e.target.value as 'edit' | 'download' } })
          }
        >
          <option value="edit">Open in editor</option>
          <option value="download">Download</option>
        </Select>
      </Field>

      <SectionTitle description="Save everything a session prints to a text file, one folder per host.">
        Session logs
      </SectionTitle>
      <Field label="Record sessions">
        <Select
          className="w-64"
          data-testid="setting-logging-mode"
          value={logging.mode}
          onChange={(e) =>
            void update({ logging: { mode: e.target.value as 'off' | 'ssh' | 'all' } })
          }
        >
          <option value="off">Off</option>
          <option value="ssh">SSH sessions</option>
          <option value="all">All sessions (SSH and local)</option>
        </Select>
      </Field>
      <Field label="Folder" hint="New sessions use the new folder.">
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
            onClick={() =>
              void window.shellhouse.pickFolder('Choose a folder for session logs').then((dir) => {
                if (dir) void update({ logging: { directory: dir } })
              })
            }
          >
            Choose…
          </Button>
          <Button
            variant="ghost"
            icon={<FolderOpen size={13} />}
            data-testid="open-log-folder"
            onClick={() => void window.shellhouse.openLogFolder()}
          >
            Open
          </Button>
        </div>
      </Field>
      <Checkbox
        label="Plain text (remove colors and terminal control codes)"
        checked={logging.stripAnsi}
        onChange={(e) => void update({ logging: { stripAnsi: e.target.checked } })}
      />
      {logging.mode !== 'off' && (
        <Notice tone="warning" testId="logging-warning">
          Logs contain everything shown in the terminal, including secrets printed on screen. They
          are stored unencrypted.
        </Notice>
      )}
    </div>
  )
}
