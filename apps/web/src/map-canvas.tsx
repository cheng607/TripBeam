import { useCallback, useEffect, useRef, useState } from 'react';
import type { Place, TripRoute } from '@tripbeam/contracts';
import { type AMapApi, type AMapMap, loadAMap } from './amap-loader';
import { displayCoordinate } from './map-coordinates';
import { routeColor } from './route-colors';

function RouteSketch({ origin, routes, activeRouteId, routeColorOffset }: { origin: Place; routes: TripRoute[]; activeRouteId: string; routeColorOffset: number }) {
  const points = [origin.coordinate, ...routes.flatMap((route) => [...route.legs.flatMap((leg) => leg.geometry), ...route.pois.map((poi) => poi.place.coordinate)])].map(displayCoordinate);
  const meanLat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
  const projected = points.map((point) => ({ x: point.lng * Math.cos(meanLat * Math.PI / 180), y: point.lat }));
  const minX = Math.min(...projected.map((point) => point.x)); const maxX = Math.max(...projected.map((point) => point.x));
  const minY = Math.min(...projected.map((point) => point.y)); const maxY = Math.max(...projected.map((point) => point.y));
  const spanX = Math.max(maxX - minX, .00002); const spanY = Math.max(maxY - minY, .00002); const scale = Math.min(820 / spanX, 500 / spanY);
  const project = (coordinate: Place['coordinate']) => {
    const point = displayCoordinate(coordinate);
    return { x: 90 + (820 - spanX * scale) / 2 + (point.lng * Math.cos(meanLat * Math.PI / 180) - minX) * scale, y: 80 + (500 - spanY * scale) / 2 + (maxY - point.lat) * scale };
  };
  const originPoint = project(origin.coordinate);
  return <svg className="route-sketch" viewBox="0 0 1000 660" role="img" aria-label="高德地图不可用时按真实线路几何绘制的路线示意图">
    <text x="36" y="38" className="sketch-caption">路线示意 · 根据线路与地点位置绘制</text>
    {routes.map((route, routeIndex) => {
      const active = route.id === activeRouteId; const color = routeColor(routeIndex + routeColorOffset);
      return <g key={route.id} className={active ? 'sketch-route is-active' : 'sketch-route'} style={{ color }}>
        {route.legs.map((leg, legIndex) => { const legPoints = leg.geometry.map(project); return legPoints.length > 1 ? <polyline key={legIndex} points={legPoints.map((point) => String(point.x) + ',' + String(point.y)).join(' ')} /> : null; })}
        {route.pois.map((poi, index) => {
          const point = project(poi.place.coordinate); const labelX = Math.min(840, point.x + 23); const labelY = Math.max(82, Math.min(556, point.y - 16 + (index % 2) * 30)); const label = poi.name.length > 9 ? poi.name.slice(0, 9) + '…' : poi.name;
          return <g key={poi.id} className="sketch-stop"><circle cx={point.x} cy={point.y} r="16" /><text x={point.x} y={point.y + 5} textAnchor="middle">{index + 1}</text>{active && <g className="sketch-label"><rect x={labelX} y={labelY} width="132" height="34" rx="10" /><text x={labelX + 12} y={labelY + 22}>{label}</text></g>}</g>;
        })}
      </g>;
    })}
    <g className="sketch-origin"><circle cx={originPoint.x} cy={originPoint.y} r="18" /><text x={originPoint.x} y={originPoint.y + 5} textAnchor="middle">出</text></g>
  </svg>;
}

function amapPosition(coordinate: Place['coordinate']): [number, number] {
  const point = displayCoordinate(coordinate);
  return [point.lng, point.lat];
}

function markerContent(label: string, color: string, selected = false): HTMLDivElement {
  const element = document.createElement('div');
  element.className = 'amap-trip-marker' + (selected ? ' is-selected' : '');
  element.style.setProperty('--marker-color', color);
  element.textContent = label;
  return element;
}

export function MapCanvas({ origin, routes, activeRouteId, activeStopIndex, onSelectStop, onSelectRoute, routeColorOffset = 0 }: { origin: Place; routes: TripRoute[]; activeRouteId: string; activeStopIndex?: number; onSelectStop?: (index: number) => void; onSelectRoute?: (id: string) => void; routeColorOffset?: number }) {
  const element = useRef<HTMLDivElement>(null); const map = useRef<AMapMap | null>(null); const mapApi = useRef<AMapApi | null>(null);
  const fitOverlays = useRef<unknown[]>([]); const lastFittedShape = useRef(''); const [mapVersion, setMapVersion] = useState(0); const [mapError, setMapError] = useState<string | null>(null);
  const fitMaxZoom = onSelectRoute ? 20 : 19; const fitPadding = onSelectRoute ? 16 : 42;
  const fitAllRoutes = useCallback(() => {
    if (map.current && fitOverlays.current.length) map.current.setFitView(fitOverlays.current, false, [fitPadding, fitPadding, fitPadding, fitPadding], fitMaxZoom);
  }, [fitMaxZoom, fitPadding]);

  useEffect(() => {
    if (!element.current) return;
    let cancelled = false; let instance: AMapMap | null = null; setMapError(null);
    void loadAMap().then((AMap) => {
      if (cancelled || !element.current) return;
      instance = new AMap.Map(element.current, { center: amapPosition(origin.coordinate), zoom: 13, viewMode: '2D', resizeEnable: true, zooms: [3, 20] });
      instance.add([new AMap.ToolBar({ position: { top: '84px', right: '12px' } }), new AMap.Scale({ position: { bottom: '14px', left: '12px' } })]);
      map.current = instance; mapApi.current = AMap; setMapVersion((version) => version + 1);
    }).catch((error: unknown) => { if (!cancelled) setMapError(error instanceof Error ? error.message : '高德地图加载失败。'); });
    return () => {
      cancelled = true;
      const activeMap = map.current;
      if (activeMap && activeMap === instance) { activeMap.destroy(); map.current = null; mapApi.current = null; }
    };
  }, [origin.coordinate.lat, origin.coordinate.lng]);

  useEffect(() => {
    const instance = map.current; const AMap = mapApi.current;
    if (!instance || !AMap) return;
    instance.clearMap();
    const overlays: unknown[] = [];
    overlays.push(new AMap.Marker({ position: amapPosition(origin.coordinate), content: markerContent('出', '#1f2d27'), anchor: 'center', title: '出发点：' + origin.label, zIndex: 150 }));
    routes.map((route, routeIndex) => ({ route, routeIndex })).sort((a, b) => Number(a.route.id === activeRouteId) - Number(b.route.id === activeRouteId)).forEach(({ route, routeIndex }) => {
      const active = route.id === activeRouteId; const color = routeColor(routeIndex + routeColorOffset);
      route.legs.forEach((leg) => {
        const path = leg.geometry.map(amapPosition); if (path.length < 2) return;
        if (!active) overlays.push(new AMap.Polyline({ path, strokeColor: color, strokeWeight: 16, strokeOpacity: .30, strokeLineJoin: 'round', strokeLineCap: 'round', bubble: true, zIndex: 20 }));
        const line = new AMap.Polyline({ path, strokeColor: color, strokeWeight: active ? 9 : 6, strokeOpacity: active ? 1 : .9, strokeLineJoin: 'round', strokeLineCap: 'round', bubble: true, zIndex: active ? 40 : 30 });
        if (onSelectRoute) line.on('click', () => onSelectRoute(route.id)); overlays.push(line);
      });
      route.pois.forEach((poi, index) => {
        const selected = active && index === activeStopIndex;
        const marker = new AMap.Marker({ position: amapPosition(poi.place.coordinate), content: markerContent(active ? String(index + 1) : '', color, selected), anchor: 'center', title: active ? poi.name : route.title + ' · ' + poi.name, zIndex: selected ? 200 : active ? 100 : 70 });
        if (active && onSelectStop) marker.on('click', () => onSelectStop(index));
        if (!active && onSelectRoute) marker.on('click', () => onSelectRoute(route.id));
        overlays.push(marker);
      });
    });
    instance.add(overlays); fitOverlays.current = overlays;
    const shape = String(origin.coordinate.lat) + ',' + String(origin.coordinate.lng) + ':' + routes.map((route) => route.id + ':' + route.pois.map((poi) => poi.id).join(',')).join('|');
    if (lastFittedShape.current !== shape) { lastFittedShape.current = shape; fitAllRoutes(); }
    return () => { if (map.current === instance) instance.clearMap(); };
  }, [origin, routes, activeRouteId, activeStopIndex, onSelectStop, onSelectRoute, routeColorOffset, mapVersion, fitAllRoutes]);

  useEffect(() => {
    const instance = map.current; if (!instance || !element.current) return;
    const observer = new ResizeObserver(() => instance.resize()); observer.observe(element.current); return () => observer.disconnect();
  }, [mapVersion]);

  const hasGeometry = routes.some((route) => route.legs.some((leg) => leg.geometry.length >= 2)); const unavailable = Boolean(mapError);
  return <div className={'real-map' + (unavailable && hasGeometry ? ' has-route-sketch' : '')} aria-label="高德真实路网地图">
    <div ref={element} className="amap-host" />{unavailable && hasGeometry && <RouteSketch origin={origin} routes={routes} activeRouteId={activeRouteId} routeColorOffset={routeColorOffset} />}{(!hasGeometry || unavailable) && <div className="map-unavailable">{unavailable ? mapError + ' 上方为路线示意。' : '线路几何暂不可用，请查看地点清单。'}</div>}
    <div className="map-legend" aria-label="地图线路图例">{routes.map((route, index) => onSelectRoute ? <button type="button" className={route.id === activeRouteId ? 'active' : ''} aria-pressed={route.id === activeRouteId} key={route.id} onClick={() => onSelectRoute(route.id)}><i style={{ background: routeColor(index + routeColorOffset) }} />方案 {String.fromCharCode(65 + index + routeColorOffset)} · {route.title}</button> : <span className={route.id === activeRouteId ? 'active' : ''} key={route.id}><i style={{ background: routeColor(index + routeColorOffset) }} />方案 {String.fromCharCode(65 + index + routeColorOffset)} · {route.title}</span>)}</div>
    {routes.length > 1 && <button className="map-fit-button" type="button" onClick={fitAllRoutes}>查看全部线路</button>}
  </div>;
}
