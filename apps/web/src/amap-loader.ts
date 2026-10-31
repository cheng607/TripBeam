export type AMapMap = {
  add: (overlays: unknown | unknown[]) => void;
  clearMap: () => void;
  destroy: () => void;
  resize: () => void;
  setFitView: (overlays?: unknown[], immediately?: boolean, avoid?: number[], maxZoom?: number) => void;
};

export type AMapOverlay = {
  on: (event: string, handler: () => void) => void;
};

export type AMapApi = {
  Map: new (container: HTMLElement, options: Record<string, unknown>) => AMapMap;
  Polyline: new (options: Record<string, unknown>) => AMapOverlay;
  Marker: new (options: Record<string, unknown>) => AMapOverlay;
  ToolBar: new (options?: Record<string, unknown>) => unknown;
  Scale: new (options?: Record<string, unknown>) => unknown;
};

declare global {
  interface Window {
    AMap?: AMapApi;
    _AMapSecurityConfig?: { securityJsCode: string };
  }
}

const scriptId = 'tripbeam-amap-js-api';
let pendingLoad: Promise<AMapApi> | undefined;

export class AMapLoadError extends Error {
  constructor(readonly code: 'MISSING_KEY' | 'LOAD_FAILED') {
    super(code === 'MISSING_KEY' ? '尚未配置高德地图 JS API Key。' : '高德地图加载失败。');
  }
}

export function loadAMap(): Promise<AMapApi> {
  if (window.AMap) return Promise.resolve(window.AMap);
  if (pendingLoad) return pendingLoad;
  const key = import.meta.env.VITE_AMAP_JS_KEY?.trim();
  if (!key) return Promise.reject(new AMapLoadError('MISSING_KEY'));

  const securityJsCode = import.meta.env.VITE_AMAP_SECURITY_JS_CODE?.trim();
  if (securityJsCode) window._AMapSecurityConfig = { securityJsCode };

  pendingLoad = new Promise<AMapApi>((resolve, reject) => {
    const existing = document.getElementById(scriptId) as HTMLScriptElement | null;
    const script = existing ?? document.createElement('script');
    const finish = () => window.AMap ? resolve(window.AMap) : reject(new AMapLoadError('LOAD_FAILED'));
    script.addEventListener('load', finish, { once: true });
    script.addEventListener('error', () => reject(new AMapLoadError('LOAD_FAILED')), { once: true });
    if (!existing) {
      script.id = scriptId;
      script.async = true;
      script.src = 'https://webapi.amap.com/maps?v=2.0&key=' + encodeURIComponent(key) + '&plugin=AMap.ToolBar,AMap.Scale';
      document.head.appendChild(script);
    }
  }).catch((error: unknown) => {
    pendingLoad = undefined;
    throw error;
  });
  return pendingLoad;
}
