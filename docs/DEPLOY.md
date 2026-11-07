# 部署說明

TanStack Start + Vite + Nitro。

- **Render（預設）**：`NITRO_PRESET` 未設時用 `node-server`
- **Vercel**：專案環境變數設 `NITRO_PRESET=vercel`

## Render（Web Service 表單怎麼填）

Preset **不是**在 Render 網頁上改，而是在 repo 的 `vite.config.ts`（已支援）。  
你在 **New Web Service** 畫面往下捲，填：

| 欄位 | 填什麼 |
|------|--------|
| Name | `craft-flame-birch-able`（可維持預設） |
| Language | Node |
| Branch | `main` |
| Region | Oregon 即可 |
| Root Directory | **留空** |
| **Build Command** | `npm install && npm run build` |
| **Start Command** | `node .output/server/index.mjs` |
| Instance | Free（或你選的方案） |

Environment Variables 建議加：

- `NODE_VERSION` = `20`
- `NITRO_PRESET` = `node-server`（可選，預設已是 node-server）

若 repo 有 `render.yaml`，也可改用 **Blueprint** 一鍵建立。

建置成功後若 Start 失敗，到 Shell 看 `.output` 實際路徑：

```bash
ls -la .output
ls -la .output/server
```

有時入口是 `.output/server/index.mjs` 或 `node_modules/nitro/...`，以建置 log 為準。

## Vercel

Import repo → Build 預設即可。環境變數加：

- `NITRO_PRESET` = `vercel`

## 本機

```bash
npm install
npm run dev
npm run build
```
