# Inline Comments for Hermes Desktop

Review an agent's work the way you'd review a document: select text in a reply or in a file it
wrote, leave a comment, and send all your comments with your next message.

![Demo: installing the plugin, commenting on a reply and on files, editing a comment, and sending](assets/demo.webp)

## Install

You need Hermes Desktop **0.22.5** or newer.

**One-click link.** Open this in a browser on the machine running Hermes Desktop:

```
hermes://plugin/install?repo=https://github.com/rednaks/hermes-desktop-inline-comments.git
```

Hermes shows a confirmation dialog first. Nothing is installed until you confirm.

**From the app.** Go to **Capabilities → Plugins → Install from Git**, paste this URL, tick
**Desktop plugin** and click **Install**:

```
https://github.com/rednaks/hermes-desktop-inline-comments
```

**By hand.** Copy `desktop/plugin.js` to
`~/.hermes/desktop-plugins/hermes-desktop-inline-comments/plugin.js`. The app picks it up within a
few seconds.

If the plugin doesn't appear, check that it's switched on under **Capabilities → Plugins**, or run
⌘K / Ctrl+K → **Reload desktop plugins**.

## Usage

| Do this | What happens |
|---|---|
| Select text in an agent reply, or in a file open in the preview pane (rendered markdown or source) | An **Add to reply** button appears above the selection. **Ctrl/Cmd+Alt+C** does the same. |
| Type a comment, press **Enter** | The comment is pending: the text gets highlighted, and the comment is listed above the composer. **Shift+Enter** starts a new line; **Esc** or clicking outside discards. |
| Click a highlight | Edit the comment, or delete it with the bin icon. |
| Click a comment in the list above the composer | Scrolls to its highlight. **×** removes it. |
| Type a message, press **Enter** | Your pending comments are added to the message. |
| Press **Enter** in an empty composer, or click **Send comments** | The comments are sent on their own. |

Selections extend to whole words. Pending comments are kept per chat and survive an app restart.
Slash commands such as `/compress` never pick them up.

The command palette (⌘K / Ctrl+K) has three commands: **Send pending comments**, **Clear pending
comments** and **Restore last sent comments**. Use the last one if a send fails.

### What the agent receives

```
Thanks! Two notes on this:

💬 Comments on your last reply (2):

❝retry up to 10 times❞
↳ cap it at 3 retries with jitter

❝log the full response body❞
↳ careful, it may contain PII

💬 Comment on `docs/plan.md`:

❝two engineers❞
↳ we only have one until May
```

Comments are grouped per target: your last reply first, then one group per file. File paths are
relative to the chat's working folder when the file is inside it. In your own chat history, the
plugin shows each comment as a compact one-line row (hover it for the full text), with a file label
on file comments.

## Privacy

The plugin runs entirely inside the desktop app. It makes no network calls, needs no credentials
and has no Python or agent-side code. Pending comments are stored in the app's local plugin storage
(`hermes.plugin.hermes-desktop-inline-comments.*`).

## Known limitations

- **It relies on the app's internal page structure in three places**: detecting selections in agent
  replies, drawing quote cards in your sent messages, and making Enter in an empty composer send
  the comments. The plugin API doesn't cover these yet, so a Hermes Desktop update could break one
  of them. If that happens, sending still works: the agent still gets your comments as plain text.
  This is also why the plugin isn't in the official Hermes plugin catalog yet.
- If you send while the agent is still replying, your message steers the running reply and the
  comments aren't added. They stay pending for your next message.
- A file comment's highlight only shows while that file is open in the preview pane. Closed, the
  comment stays pending; clicking it in the list tells you which file to open.
- Highlights are found again by text after a reload. If the quoted text appears more than once in a
  reply, the last occurrence is highlighted.
- Hermes fades out the bottom of long sent messages, so with three or more comments the last row of
  the sent message can be partly hidden. The agent still receives every comment in full.

## Development

`desktop/plugin.js` is a plain ES module loaded uncompiled by the Desktop plugin loader. It imports
only `@hermes/plugin-sdk` and `react/jsx-runtime`. To work on it, symlink this checkout into your
plugins folder so every save hot-reloads:

```bash
ln -s "$PWD" ~/.hermes/plugins/hermes-desktop-inline-comments
```

## License

[MIT](LICENSE) © Skander BM
