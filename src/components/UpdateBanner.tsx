interface UpdateBannerProps {
  version: string;
  url: string;
  onDismiss: () => void;
}

/**
 * Slim, dismissible row under the toolbar announcing a newer release.
 * Deliberately not an auto-updater: the user stays in control — the link
 * opens the release page in their browser and they install when they choose.
 */
export default function UpdateBanner({ version, url, onDismiss }: UpdateBannerProps) {
  const handleView = async () => {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
    } catch {
      // Non-Tauri context (plain browser build).
      window.open(url, '_blank', 'noopener');
    }
  };

  return (
    <div className="update-banner" role="status">
      <span>
        Quill <strong>{version}</strong> is available.
      </span>
      <button type="button" className="update-banner-link" onClick={handleView}>
        View release
      </button>
      <button
        type="button"
        className="update-banner-dismiss"
        onClick={onDismiss}
        aria-label="Dismiss update notification"
      >
        ×
      </button>
    </div>
  );
}
