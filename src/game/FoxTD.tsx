import { useEffect, useRef, useState } from "react";

/**
 * 緊急占位：上一版推送誤寫入路徑字串。
 * 請用本機 sanctuary-escort-paths.zip 或 FoxTD-push-me.tsx 覆蓋此檔後再 push。
 * 完整版含：聖地護衛、路線升級、bootstrap、攻擊幀、明潮砂等。
 */
export default function FoxTD() {
  return (
    <div className="shell" style={{ padding: 24, maxWidth: 640 }}>
      <h1 style={{ color: "#ffe08a" }}>FoxTD 需還原完整原始碼</h1>
      <p style={{ color: "#c5dff2", lineHeight: 1.6 }}>
        遠端 <code>src/game/FoxTD.tsx</code> 曾被誤寫。請下載對話中的{" "}
        <b>FoxTD-push-me.tsx</b> 或 <b>sanctuary-escort-paths.zip</b>，覆蓋本檔後執行：
      </p>
      <pre style={{ background: "#08131f", padding: 12, borderRadius: 8, color: "#9ec4de" }}>
{`cp FoxTD-push-me.tsx src/game/FoxTD.tsx
git add src/game/FoxTD.tsx
git commit -m "Restore full FoxTD with sanctuary system"
git push`}
      </pre>
      <p style={{ color: "#8eb6d4", fontSize: 13 }}>
        tiles.ts（地圖／聖地 5×5／bootstrap）已在遠端，無需重推。
      </p>
    </div>
  );
}
