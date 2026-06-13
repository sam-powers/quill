import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useUpdateCheck } from '../../hooks/useUpdateCheck';

function mockRelease(tag: string, url = `https://github.com/sam-powers/quill/releases/tag/${tag}`) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ tag_name: tag, html_url: url }),
  });
}

describe('useUpdateCheck', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('surfaces a newer published release', async () => {
    vi.stubGlobal('fetch', mockRelease('v0.4.0'));
    const { result } = renderHook(() => useUpdateCheck({ currentVersion: '0.3.0', enabled: true }));

    await waitFor(() => expect(result.current.update).not.toBeNull());
    expect(result.current.update).toEqual({
      version: '0.4.0',
      url: 'https://github.com/sam-powers/quill/releases/tag/v0.4.0',
    });
  });

  it('stays quiet when the latest release is the running version', async () => {
    const fetchMock = mockRelease('v0.3.0');
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useUpdateCheck({ currentVersion: '0.3.0', enabled: true }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current.update).toBeNull();
  });

  it('does not fetch at all when disabled', () => {
    const fetchMock = mockRelease('v0.4.0');
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useUpdateCheck({ currentVersion: '0.3.0', enabled: false }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stays quiet on a non-OK response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useUpdateCheck({ currentVersion: '0.3.0', enabled: true }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current.update).toBeNull();
  });

  it('stays quiet when the network is down', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network down'));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useUpdateCheck({ currentVersion: '0.3.0', enabled: true }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current.update).toBeNull();
  });

  it('dismiss hides the update and persists across launches', async () => {
    vi.stubGlobal('fetch', mockRelease('v0.4.0'));
    const first = renderHook(() => useUpdateCheck({ currentVersion: '0.3.0', enabled: true }));
    await waitFor(() => expect(first.result.current.update).not.toBeNull());

    act(() => first.result.current.dismiss());
    expect(first.result.current.update).toBeNull();
    first.unmount();

    // "Next launch": the same version stays dismissed.
    const fetchMock = mockRelease('v0.4.0');
    vi.stubGlobal('fetch', fetchMock);
    const second = renderHook(() => useUpdateCheck({ currentVersion: '0.3.0', enabled: true }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(second.result.current.update).toBeNull();
  });

  it('falls back to the releases page when html_url is not a github.com https URL', async () => {
    // A spoofed/compromised response must not redirect the user anywhere.
    vi.stubGlobal('fetch', mockRelease('v0.4.0', 'javascript:alert(1)'));
    const { result } = renderHook(() => useUpdateCheck({ currentVersion: '0.3.0', enabled: true }));

    await waitFor(() => expect(result.current.update).not.toBeNull());
    expect(result.current.update?.url).toBe('https://github.com/sam-powers/quill/releases/latest');
  });

  it('falls back to the releases page when html_url is a non-github host', async () => {
    vi.stubGlobal('fetch', mockRelease('v0.4.0', 'https://evil.example.com/phish'));
    const { result } = renderHook(() => useUpdateCheck({ currentVersion: '0.3.0', enabled: true }));

    await waitFor(() => expect(result.current.update).not.toBeNull());
    expect(result.current.update?.url).toBe('https://github.com/sam-powers/quill/releases/latest');
  });

  it('a release newer than a dismissed one still shows', async () => {
    localStorage.setItem('quill.dismissed-update', '0.4.0');
    vi.stubGlobal('fetch', mockRelease('v0.5.0'));
    const { result } = renderHook(() => useUpdateCheck({ currentVersion: '0.3.0', enabled: true }));

    await waitFor(() => expect(result.current.update).not.toBeNull());
    expect(result.current.update?.version).toBe('0.5.0');
  });
});
