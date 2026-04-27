# Amp Web

> **⚠️ Warning**
>
> Don't take this project too seriously! It's just a sandbox for me to experiment with `wterm`.

<img width="2239" height="1327" alt="amp-web" src="https://github.com/user-attachments/assets/adcecfb6-7c72-42e3-8366-7a5f03d2397e" />


Browser wrapper for the interactive `amp` CLI using `wterm` and a PTY-backed WebSocket bridge.

## Scripts

```bash
bun install
bun run dev
```

Open `http://127.0.0.1:3000` in your browser.

## Environment

- `HOST`: HTTP bind host. Defaults to `127.0.0.1`.
- `PORT`: HTTP port. Defaults to `3000`.
- `AMP_COMMAND`: Full command launched inside the PTY. Defaults to `amp`.
- `AMP_WORKSPACE`: Working directory for the Amp session. When set to an existing directory, Amp opens there immediately. When unset or invalid, the browser shows a workspace picker before launching Amp.

## Build

```bash
bun run build
bun run start
```
