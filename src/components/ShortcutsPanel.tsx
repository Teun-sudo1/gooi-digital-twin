import { SHORTCUTS } from '../hooks/useKeyboardShortcuts'
import { useAppStore } from '../store/useAppStore'

export function ShortcutsPanel() {
  const open = useAppStore((s) => s.shortcutsOpen)
  const setOpen = useAppStore((s) => s.setShortcutsOpen)
  if (!open) return null

  return (
    <div className="shortcuts panel" role="dialog" aria-label="Keyboard shortcuts">
      <div className="panel-title">
        <span>Keyboard shortcuts</span>
        <button className="icon-button" onClick={() => setOpen(false)} aria-label="Close">
          ×
        </button>
      </div>
      <dl>
        {SHORTCUTS.map((shortcut) => (
          <div key={shortcut.description}>
            <dt>
              {shortcut.keys.map((key) => (
                <kbd key={key}>{key}</kbd>
              ))}
            </dt>
            <dd>{shortcut.description}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
