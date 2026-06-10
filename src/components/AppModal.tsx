export interface AppModalButton {
  label: string;
  kind?: 'primary' | 'danger' | 'ghost';
  onClick: () => void | Promise<void>;
}

interface AppModalProps {
  title: string;
  message: string;
  buttons: AppModalButton[];
}

const BUTTON_CLASS: Record<NonNullable<AppModalButton['kind']>, string> = {
  primary: 'btn-primary',
  danger: 'btn-danger',
  ghost: 'btn-ghost',
};

/**
 * In-app modal for confirmations and notices. Used instead of
 * window.alert/confirm, which are not reliably implemented in Tauri's
 * webviews.
 */
export default function AppModal({ title, message, buttons }: AppModalProps) {
  return (
    <div className="app-modal-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="app-modal">
        <h2 className="app-modal-title">{title}</h2>
        <p className="app-modal-message">{message}</p>
        <div className="app-modal-actions">
          {buttons.map((b) => (
            <button
              key={b.label}
              className={BUTTON_CLASS[b.kind ?? 'ghost']}
              onClick={() => void b.onClick()}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
