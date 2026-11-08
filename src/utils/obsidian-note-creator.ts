import browser from './browser-polyfill';
import { sanitizeFileName } from '../utils/string-utils';
import { generateFrontmatter as generateFrontmatterCore } from './shared';
import { Template, Property } from '../types/types';
import { generalSettings, incrementStat } from './storage-utils';
import { copyToClipboard } from './clipboard-utils';
import { getMessage } from './i18n';

export async function generateFrontmatter(properties: Property[]): Promise<string> {
	const typeMap: Record<string, string> = {};
	for (const pt of generalSettings.propertyTypes) {
		typeMap[pt.name] = pt.type;
	}
	return generateFrontmatterCore(properties, typeMap);
}

export interface IgnisSaveResult {
	path: string;
	byteCount: number;
	verified: boolean;
}

function formatIgnisResponseError(status: number, responseText: string): string {
	const responseBody = responseText.trim();
	if (responseBody.startsWith('(()=>{') || responseBody.includes('__webpack_modules__')) {
		return `Ignis API error: ${status}. The server returned JavaScript instead of an API response. Check the Ignis URL and reverse-proxy routing.`;
	}

	const detail = responseBody
		? `${responseBody.slice(0, 240)}${responseBody.length > 240 ? '…' : ''}`
		: 'No response body';
	return `Ignis API error: ${status} ${detail}`;
}

function openObsidianUrl(url: string): void {
	browser.runtime.sendMessage({
		action: "openObsidianUrl",
		url: url
	}).catch((error) => {
		console.error('Error opening Obsidian URL via background script:', error);
		window.open(url, '_blank');
	});
}

async function tryClipboardWrite(fileContent: string, obsidianUrl: string): Promise<void> {
	const success = await copyToClipboard(fileContent);

	if (success) {
		// &clipboard tells Obsidian to read data from clipboard instead of the content param.
		// content is a fallback shown only if Obsidian can't access the clipboard (e.g. on Linux).
		obsidianUrl += `&clipboard&content=${encodeURIComponent(getMessage('clipboardError', 'https://help.obsidian.md/web-clipper/troubleshoot'))}`;
		openObsidianUrl(obsidianUrl);
		console.log('Obsidian URL:', obsidianUrl);
	} else {
		console.error('All clipboard methods failed, falling back to URI method');
		// Final fallback: use URI method with actual content (same as legacy mode)
		// Note: We don't add &clipboard here since we're bypassing the clipboard entirely
		obsidianUrl += `&content=${encodeURIComponent(fileContent)}`;
		openObsidianUrl(obsidianUrl);
		console.log('Obsidian URL (URI fallback):', obsidianUrl);
	}
}

export async function saveToIgnis(
	fileContent: string,
	noteName: string,
	path: string,
	vault: string,
	behavior: Template['behavior'],
): Promise<IgnisSaveResult> {
	let baseUrl: URL;
	try {
		baseUrl = new URL(generalSettings.ignisUrl.trim());
	} catch {
		throw new Error('Invalid Ignis URL. Open extension settings and enter a complete URL including https://.');
	}
	if (!['http:', 'https:'].includes(baseUrl.protocol) || !baseUrl.hostname) {
		throw new Error('Invalid Ignis URL. Use an HTTP or HTTPS address in extension settings.');
	}

	const authToken = generalSettings.ignisAuthToken;

	const endpoint = behavior.startsWith('append') || behavior.startsWith('prepend')
		? '/api/fs/appendFile'
		: '/api/fs/writeFile';

	const sanitizedNoteName = sanitizeFileName(noteName);
	const formattedNoteName = sanitizedNoteName.toLowerCase().endsWith('.md')
		? sanitizedNoteName
		: `${sanitizedNoteName}.md`;
	const filePath = path ? `${path}/${formattedNoteName}` : formattedNoteName;
	const selectedVault = vault || baseUrl.searchParams.get('vault') || 'Inbox';
	const vaultValue = selectedVault.split('/').pop() || selectedVault;
	const apiUrl = new URL(endpoint, baseUrl);
	apiUrl.searchParams.set('vault', vaultValue);

	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
	};
	if (authToken) {
		headers.Authorization = `Basic ${btoa(unescape(encodeURIComponent(authToken)))}`;
	}

	const options = {
		method: 'POST',
		headers,
		body: JSON.stringify({
			path: filePath,
			content: fileContent,
			vault: selectedVault,
			flush: true,
		}),
	};

	type FetchProxyResult = { ok: boolean; status: number; text: string; error?: string };
	const sendFetchProxy = (url: URL, requestOptions: RequestInit) => browser.runtime.sendMessage({
		action: 'fetchProxy',
		url: url.toString(),
		options: requestOptions,
	}) as Promise<FetchProxyResult>;

	const sendRequest = async (url: URL, requestOptions: RequestInit): Promise<FetchProxyResult> => {
		let result = await sendFetchProxy(url, requestOptions);
		if (result?.error === 'CORS_PERMISSION_NEEDED') {
			const granted = await browser.permissions.request({ origins: [`${url.origin}/*`] });
			if (!granted) {
				throw new Error(`Host permission not granted for ${url.origin}`);
			}
			result = await sendFetchProxy(url, requestOptions);
		}

		return result;
	};

	const result = await sendRequest(apiUrl, options);
	if (result?.error) {
		throw new Error(`Cannot connect to Ignis: ${result.error}`);
	}
	if (!result?.ok) {
		throw new Error(formatIgnisResponseError(result?.status ?? 0, result?.text ?? ''));
	}

	let verified = false;
	const byteCount = new TextEncoder().encode(fileContent).byteLength;
	if (endpoint === '/api/fs/writeFile') {
		let responseBody: { size?: unknown; flushed?: unknown } | null;
		try {
			responseBody = JSON.parse(result.text) as { size?: unknown };
		} catch {
			throw new Error('Ignis accepted the request but returned an unreadable write response. Check the deployed Ignis server version.');
		}
		if (!responseBody || typeof responseBody !== 'object' || typeof responseBody.size !== 'number') {
			throw new Error('Ignis accepted the request but did not report the written file size. Update the Ignis server to verify the save.');
		}
		if (responseBody.flushed !== true) {
			throw new Error('Ignis accepted the clip but did not confirm it was flushed to disk. Update and redeploy the Ignis server before clipping.');
		}
		if (responseBody.size !== byteCount) {
			throw new Error(`Ignis reported writing ${responseBody.size} bytes, but the clip contains ${byteCount} bytes. Check the deployed Ignis server version and request-body parsing.`);
		}

		const readbackUrl = new URL('/api/fs/readFile', baseUrl);
		readbackUrl.searchParams.set('path', filePath);
		readbackUrl.searchParams.set('vault', vaultValue);
		readbackUrl.searchParams.set('encoding', 'utf-8');
		const readback = await sendRequest(readbackUrl, { method: 'GET', headers });
		if (readback?.error) {
			throw new Error(`Cannot verify Ignis write: ${readback.error}`);
		}
		if (!readback?.ok) {
			throw new Error(`Cannot verify Ignis write. ${formatIgnisResponseError(readback?.status ?? 0, readback?.text ?? '')}`);
		}
		if (readback.text !== fileContent) {
			const actualSize = new TextEncoder().encode(readback.text).byteLength;
			throw new Error(`Ignis saved ${actualSize} bytes at the requested path, but the clip contains ${byteCount} bytes. Check the selected vault and file path.`);
		}
		verified = true;
	}

	console.log('Saved to Ignis:', apiUrl.toString());
	return { path: filePath, byteCount, verified };
}

export async function saveToObsidian(
	fileContent: string,
	noteName: string,
	path: string,
	vault: string,
	behavior: Template['behavior'],
): Promise<void> {
	// Route to Ignis if configured
	if (generalSettings.useIgnis && generalSettings.ignisUrl) {
		await saveToIgnis(fileContent, noteName, path, vault, behavior);
		return;
	}

	let obsidianUrl: string;

	const isDailyNote = behavior === 'append-daily' || behavior === 'prepend-daily';

	if (isDailyNote) {
		obsidianUrl = `obsidian://daily?`;
	} else {
		// Ensure path ends with a slash
		if (path && !path.endsWith('/')) {
			path += '/';
		}

		const formattedNoteName = sanitizeFileName(noteName);
		obsidianUrl = `obsidian://new?file=${encodeURIComponent(path + formattedNoteName)}`;
	}

	if (behavior.startsWith('append')) {
		obsidianUrl += '&append=true';
	} else if (behavior.startsWith('prepend')) {
		obsidianUrl += '&prepend=true';
	} else if (behavior === 'overwrite') {
		obsidianUrl += '&overwrite=true';
	}

	const vaultParam = vault ? `&vault=${encodeURIComponent(vault)}` : '';
	obsidianUrl += vaultParam;

	// Add silent parameter if silentOpen is enabled
	if (generalSettings.silentOpen) {
		obsidianUrl += '&silent=true';
	}

	if (generalSettings.legacyMode) {
		// Use the URI method
		obsidianUrl += `&content=${encodeURIComponent(fileContent)}`;
		console.log('Obsidian URL:', obsidianUrl);
		openObsidianUrl(obsidianUrl);
	} else {
		// Try to copy to clipboard with fallback mechanisms
		await tryClipboardWrite(fileContent, obsidianUrl);
	}
}