# 部署說明

本專案是 **TanStack Start + Vite + Nitro**，目前 `vite.config.ts` 的 Nitro preset 為 **`vercel`**。

## 本機

```bash
npm install
npm run dev          # http://0.0.0.0:8080
npm run build        # 生產建置
npm run preview      # 預覽建置結果
```

## Vercel（最省事，與現有 preset 一致）

1. https://vercel.com → Import GitHub repo `craft-flame-birch-able`
2. Framework 會自動偵測；Build Command 用預設 `npm run build` 即可
3. 已有 `vercel.json`；Push 到 main 會自動部署

## Render

### 方案 A：Web Service（Node）

Render 需要 Node server preset，請先把 `vite.config.ts` 裡：

```ts
nitro({ preset: "vercel", serverDir: "./server" })
```

改成：

```ts
nitro({ preset: "node-server", serverDir: "./server" })
```

然後在 Render 建立 **Web Service**：

| 欄位 | 值 |
|------|-----|
| Build Command | `npm install && npm run build` |
| Start Command | `node .output/server/index.mjs`（若路徑不同以建置 log 為準） |
| Instance | Free / Starter |
| Node version | 20+（Environment → NODE_VERSION=20） |

環境變數若有 Auth / DB 再另行設定；純前端遊玩可先不設。

### 方案 B：Static Site（僅前端）

若建置可輸出純靜態，可選 Static Site，Publish Directory 指向 `.output/public` 或 `dist`。  
目前專案含 Nitro SSR，**優先用方案 A 或 Vercel**。

## GitHub Pages

不建議（需改 base path、關掉 SSR）。遊戲本身可改純 client-only 後再考慮。

## 注意

- `npm run build` 會跑 `db:migrate`（PGLite）；無 migrations 時通常無害
- 遊戲路由在 app 內（FoxTD），部署成功後從首頁進入即可
