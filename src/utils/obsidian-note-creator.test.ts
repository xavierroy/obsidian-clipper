import { afterEach, describe, expect, test, vi } from 'vitest';
import browser from './browser-polyfill';
import { generalSettings } from './storage-utils';
import { saveToIgnis } from './obsidian-note-creator';

describe('saveToIgnis', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		generalSettings.ignisUrl = '';
		generalSettings.ignisAuthToken = '';
	});

	test('sends the note content as JSON to Ignis', async () => {
		generalSettings.ignisUrl = 'https://notes.example/?vault=Inbox';
		const sendMessage = vi.spyOn(browser.runtime, 'sendMessage')
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				text: JSON.stringify({ ok: true, size: 12, flushed: true }),
			})
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				text: 'article body',
			});

		await saveToIgnis('article body', 'Article', 'Clips', 'Inbox', 'create');

		expect(sendMessage).toHaveBeenCalledTimes(2);
		const [writeRequest] = sendMessage.mock.calls[0];
		expect(writeRequest).toMatchObject({
			action: 'fetchProxy',
			url: 'https://notes.example/api/fs/writeFile?vault=Inbox',
			options: {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					path: 'Clips/Article.md',
					content: 'article body',
					vault: 'Inbox',
					flush: true,
				}),
			},
		});
		const [readRequest] = sendMessage.mock.calls[1];
		expect(readRequest).toMatchObject({
			action: 'fetchProxy',
			url: 'https://notes.example/api/fs/readFile?path=Clips%2FArticle.md&vault=Inbox&encoding=utf-8',
			options: { method: 'GET' },
		});
	});

	test('does not duplicate an existing Markdown extension', async () => {
		generalSettings.ignisUrl = 'https://notes.example';
		const sendMessage = vi.spyOn(browser.runtime, 'sendMessage')
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				text: JSON.stringify({ ok: true, size: 12, flushed: true }),
			})
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				text: 'article body',
			});

		await saveToIgnis('article body', 'Article.MD', '', 'Inbox', 'create');

		const [writeRequest] = sendMessage.mock.calls[0];
		expect(writeRequest).toMatchObject({
			options: {
				body: JSON.stringify({
					path: 'Article.MD',
					content: 'article body',
					vault: 'Inbox',
					flush: true,
				}),
			},
		});
	});

	test('reports when read-back content differs from the submitted clip', async () => {
		generalSettings.ignisUrl = 'https://notes.example';
		vi.spyOn(browser.runtime, 'sendMessage')
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				text: JSON.stringify({ ok: true, size: 12, flushed: true }),
			})
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				text: '',
			});

		await expect(saveToIgnis('article body', 'Article', '', 'Inbox', 'create'))
			.rejects.toThrow('Ignis saved 0 bytes at the requested path, but the clip contains 12 bytes');
	});

	test('reports a server-confirmed zero-byte write instead of succeeding', async () => {
		generalSettings.ignisUrl = 'https://notes.example';
		vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({
			ok: true,
			status: 200,
			text: JSON.stringify({ ok: true, size: 0, flushed: true }),
		});

		await expect(saveToIgnis('article body', 'Article', '', 'Inbox', 'create'))
			.rejects.toThrow('Ignis reported writing 0 bytes, but the clip contains 12 bytes');
	});

	test('replaces an unexpected JavaScript response with a concise diagnostic', async () => {
		generalSettings.ignisUrl = 'https://notes.example';
		vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({
			ok: false,
			status: 404,
			text: `(()=>{var __webpack_modules__=${'bundle content'.repeat(1000)}})()`,
		});

		await expect(saveToIgnis('article body', 'Article', '', 'Inbox', 'create'))
			.rejects.toThrow('Ignis API error: 404. The server returned JavaScript instead of an API response.');
	});

	test('limits other server error details to a short preview', async () => {
		generalSettings.ignisUrl = 'https://notes.example';
		vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({
			ok: false,
			status: 500,
			text: 'x'.repeat(500),
		});

		await expect(saveToIgnis('article body', 'Article', '', 'Inbox', 'create'))
			.rejects.toThrow(`Ignis API error: 500 ${'x'.repeat(240)}…`);
	});
});
