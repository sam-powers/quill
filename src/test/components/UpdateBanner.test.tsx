import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import UpdateBanner from '../../components/UpdateBanner';

const openUrl = vi.fn();
vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: (url: string) => openUrl(url),
}));

const URL = 'https://github.com/sam-powers/quill/releases/tag/v0.4.0';

describe('UpdateBanner', () => {
  it('announces the new version', () => {
    render(<UpdateBanner version="0.4.0" url={URL} onDismiss={() => {}} />);
    expect(screen.getByRole('status')).toHaveTextContent('Quill 0.4.0 is available.');
  });

  it('opens the release page via the opener plugin', async () => {
    const user = userEvent.setup();
    render(<UpdateBanner version="0.4.0" url={URL} onDismiss={() => {}} />);

    await user.click(screen.getByRole('button', { name: 'View release' }));
    expect(openUrl).toHaveBeenCalledWith(URL);
  });

  it('calls onDismiss from the dismiss button', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<UpdateBanner version="0.4.0" url={URL} onDismiss={onDismiss} />);

    await user.click(screen.getByRole('button', { name: 'Dismiss update notification' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
