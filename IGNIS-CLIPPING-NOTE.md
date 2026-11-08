# Ignis clipping: investigation and fix

## Summary

Clips sent from Obsidian Web Clipper to Ignis appeared blank in the Ignis UI. Two issues were identified and addressed:

1. The clipper sent the note filename without a `.md` extension. Ignis could persist the file contents, but extensionless files were not recognized/displayed as Markdown notes as expected.
2. Ignis can coalesce writes in memory. An immediate API read-back could return pending buffered content, which did not prove that the bytes had reached disk.

The clipper now adds `.md` when needed, asks Ignis to flush writes to disk, checks the reported byte count, and reads the saved content back before reporting a verified save.

## Changes

### Obsidian Web Clipper

- [`src/utils/obsidian-note-creator.ts`](./src/utils/obsidian-note-creator.ts)
  - Adds `.md` to Ignis note paths unless the name already ends in `.md` (case-insensitive).
  - Sends `flush: true` for regular Ignis file writes.
  - Requires the server to confirm `flushed: true`, checks the disk byte count, then reads the file back and compares its contents.
- [`src/utils/obsidian-note-creator.test.ts`](./src/utils/obsidian-note-creator.test.ts)
  - Covers the request path, durable-write confirmation, read-back mismatch, zero-byte writes, and avoiding duplicate extensions.

### Ignis server

The fork patch adds optional durable-write behavior to `POST /api/fs/writeFile`:

- Requests with `flush: true` wait for the pending write to finish.
- The server stats the on-disk file and returns its actual size with `flushed: true`.
- Requests without `flush: true` retain the existing behavior.
- A route regression test verifies the data is on disk and no write remains buffered before success is returned.

The Ignis change and upstream-sync workflow were pushed to the fork branch `fix/durable-write-flush`; at last check, they were included in [PR #1](https://github.com/xavierroy/ignis/pull/1). The daily sync workflow proposes upstream changes as reviewable pull requests; it does not deploy the server automatically.

## Verification

- Ignis filesystem route tests: 40 passed.
- Clipper Ignis-save tests: 4 passed after the `.md` fix.
- Ignis lint passed.
- Chrome production extension build succeeded.
- A direct authenticated write/read test against the deployed Ignis endpoint returned the test content, and the content was visible on the Ignis site.

The latest extension build is generated at `builds/obsidian-web-clipper-1.7.1-chrome.zip`.

## Deployment and use

The server and extension changes are separate:

1. Deploy an Ignis image built from the fork branch containing the durable-write route change.
2. Install/reload the rebuilt Chrome extension.
3. Clip an article. The extension should report a verified save and include the `.md` filename.
4. Confirm the note appears in the intended Ignis vault and folder.

Existing extensionless notes are not renamed automatically. Rename them to add `.md` if they should be treated as Markdown files.

## Diagnostics and configuration notes

- If the extension says the server did not confirm a flush, the deployed Ignis image may not include the fork patch.
- If an API write/read succeeds and the note is visible on the site, but a clip fails, check the exact vault and path shown by the extension.
- For Traefik CORS, the Chrome extension origin should be `chrome-extension://oopdnfedjafdfbhnfbbiffkcmkkfgbmn` (without an `https://` prefix); allow `GET,POST,OPTIONS` for write and read-back requests. Keep CORS handling ahead of Basic Auth and remove whitespace from middleware label values.
