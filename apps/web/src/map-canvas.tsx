import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Place, TripRoute } from '@tripbeam/contracts';
import { routeColor } from './route-colors';
import { displayCoordinate } from './map-coordinates';

// Leaflet treats string tooltips as HTML. Labels can originate with users or
// external map providers, so keep them as text nodes throughout the map UI.
function tooltipText(value: string): HTMLElement {
  const element = document.createElement('span');
  element.textContent = value;
  return element;
}

function RouteSketch({ origin, routes, activeRouteId, routeColorOffset }: { origin: Place; routes: TripRoute[]; activeRouteId: string; routeColorOffset: number }) {
  const points = [origin.coordinate, ...routes.flatMap((route) => [
    ...route.legs.flatMap((leg) => leg.geometry),
    ...route.pois.map((poi) => poi.place.coordinate),
  ])].map(displayCoordinate);
  const meanLat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
  const projected = points.map((point) => ({ x: point.lng * Math.cos(meanLat * Math.PI / 180), y: point.lat }));
  const minX = Math.min(...projected.map((point) => point.x));
  const maxX = Math.max(...projected.map((point) => point.x));
  const minY = Math.min(...projected.map((point) => point.y));
  const maxY = Math.max(...projected.map((point) => point.y));
  const spanX = Math.max(maxX - minX, 0.00002);
  const spanY = Math.max(maxY - minY, 0.00002);
  const scale = Math.min(820 / spanX, 500 / spanY);
  const project = (coordinate: Place['coordinate']) => {
    const point = displayCoordinate(coordinate);
    const rawX = (point.lng * Math.cos(meanLat * Math.PI / 180) - minX) * scale;
    const rawY = (maxY - point.lat) * scale;
    return { x: 90 + (820 - spanX * scale) / 2 + rawX, y: 80 + (500 - spanY * scale) / 2 + rawY };
  };
  const originPoint = project(origin.coordinate);
  return <svg className="route-sketch" viewBox="0 0 1000 660" role="img" aria-label="无街道底图时按真实线路几何绘制的路线示意图">
    <text x="36" y="38" className="sketch-caption">路线示意 · 根据线路与地点位置绘制</text>
    {routes.map((route, routeIndex) => {
      const active = route.id === activeRouteId;
      const color = routeColor(routeIndex + routeColorOffset);
      return <g key={route.id} className={active ? 'sketch-route is-active' : 'sketch-route'} style={{ color }}>
        {route.legs.map((leg, legIndex) => {
          const legPoints = leg.geometry.map(project);
          return legPoints.length > 1 ? <polyline key={legIndex} points={legPoints.map((point) => `${point.x},${point.y}`).join(' ')} /> : null;
        })}
        {route.pois.map((poi, index) => {
          const point = project(poi.place.coordinate);
          const labelX = Math.min(840, point.x + 23);
          const labelY = Math.max(82, Math.min(556, point.y - 16 + (index % 2) * 30));
          const label = poi.name.length > 9 ? `${poi.name.slice(0, 9)}…` : poi.name;
          return <g key={poi.id} className="sketch-stop">
            <circle cx={point.x} cy={point.y} r="16" />
            <text x={point.x} y={point.y + 5} textAnchor="middle">{index + 1}</text>
            {active && <g className="sketch-label"><rect x={labelX} y={labelY} width="132" height="34" rx="10" /><text x={labelX + 12} y={labelY + 22}>{label}</text></g>}
          </g>;
        })}
      </g>;
    })}
    <g className="sketch-origin"><circle cx={originPoint.x} cy={originPoint.y} r="18" /><text x={originPoint.x} y={originPoint.y + 5} textAnchor="middle">出</text></g>
  </svg>;
}

export function MapCanvas({ origin, routes, activeRouteId, activeStopIndex, onSelectStop, onSelectRoute, routeColorOffset = 0 }: { origin: Place; routes: TripRoute[]; activeRouteId: string; activeStopIndex?: number; onSelectStop?: (index: number) => void; onSelectRoute?: (id: string) => void; routeColorOffset?: number }) {
  const element = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const allRouteBounds = useRef<L.LatLngBounds | null>(null);
  const lastFittedShape = useRef('');
  const fitMaxZoom = onSelectRoute ? 20 : 19;
  const fitPadding = onSelectRoute ? .015 : .08;
  const [tileFailed, setTileFailed] = useState(false);
  useEffect(() => {
    if (!element.current) return;
    const displayOrigin = displayCoordinate(origin.coordinate);
    const instance = L.map(element.current, { zoomControl: true, scrollWheelZoom: false, maxZoom: 20 }).setView([displayOrigin.lat, displayOrigin.lng], 13);
    map.current = instance;
    const sizeObserver = new ResizeObserver(() => instance.invalidateSize());
    sizeObserver.observe(element.current);
    const tileUrl = import.meta.env.VITE_MAP_TILE_URL;
    setTileFailed(false);
    if (!tileUrl) setTileFailed(true);
    else L.tileLayer(tileUrl, { maxNativeZoom: 19, maxZoom: 20, attribution: import.meta.env.VITE_MAP_ATTRIBUTION ?? '地图数据服务商' }).on('tileerror', () => setTileFailed(true)).addTo(instance);
    return () => { sizeObserver.disconnect(); instance.remove(); map.current = null; };
  }, [origin.coordinate.lat, origin.coordinate.lng]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const group = L.layerGroup().addTo(instance);
    const displayOrigin = displayCoordinate(origin.coordinate);
    const bounds = L.latLngBounds([[displayOrigin.lat, displayOrigin.lng]]);
    L.circleMarker([displayOrigin.lat, displayOrigin.lng], { radius: 8, color: '#1f2d27', fillColor: '#fffefb', fillOpacity: 1, weight: 3 }).bindTooltip(tooltipText(`出发点：${origin.label}`)).addTo(group);
    routes.map((route, routeIndex) => ({ route, routeIndex }))
      .sort((a, b) => Number(a.route.id === activeRouteId) - Number(b.route.id === activeRouteId))
      .forEach(({ route, routeIndex }) => {
      const active = route.id === activeRouteId;
      const color = routeColor(routeIndex + routeColorOffset);
      for (const leg of route.legs) {
        const points = leg.geometry.map((coordinate) => { const point = displayCoordinate(coordinate); return [point.lat, point.lng] as L.LatLngTuple; });
        if (points.length < 2) continue;
        // A wide translucent underlay remains visible beside the focused line
        // even where two routes use the same road. The narrow core keeps each
        // non-focused route readable on its own sections.
        if (!active) L.polyline(points, { color, weight: 16, opacity: .34, interactive: false }).addTo(group);
        const line = L.polyline(points, { color, weight: active ? 10 : 6, opacity: active ? 1 : .9 }).addTo(group);
        for (const point of points) bounds.extend(point);
        line.bindTooltip(tooltipText(`${route.title} · ${leg.mode}`));
        if (onSelectRoute) line.on('click', () => onSelectRoute(route.id));
      }
      route.pois.forEach((poi, index) => {
        const displayPoi = displayCoordinate(poi.place.coordinate);
        const point: L.LatLngTuple = [displayPoi.lat, displayPoi.lng];
        bounds.extend(point);
        if (active) {
          const markerSize = onSelectRoute ? 30 : 34;
          const selected = index === activeStopIndex;
          L.marker(point, { zIndexOffset: selected ? 1_000 : 0, icon: L.divIcon({ className: `trip-marker${selected ? ' is-selected' : ''}`, html: `<span style="--marker-color:${color}">${index + 1}</span>`, iconSize: [markerSize, markerSize], iconAnchor: [markerSize / 2, markerSize / 2] }) })
            .bindTooltip(tooltipText(poi.name)).on('click', () => onSelectStop?.(index)).addTo(group);
        } else {
          const marker = L.circleMarker(point, { radius: 7, color, weight: 2, fillColor: '#fffefb', fillOpacity: .98, opacity: .95 }).bindTooltip(tooltipText(`${route.title} · ${poi.name}`)).addTo(group);
          if (onSelectRoute) marker.on('click', () => onSelectRoute(route.id));
        }
      });
    });
    allRouteBounds.current = bounds.isValid() ? bounds : null;
    const shape = `${origin.coordinate.lat},${origin.coordinate.lng}:${routes.map((route) => `${route.id}:${route.pois.map((poi) => poi.id).join(',')}`).join('|')}`;
    if (allRouteBounds.current && lastFittedShape.current !== shape) {
      instance.fitBounds(allRouteBounds.current.pad(fitPadding), { maxZoom: fitMaxZoom });
      lastFittedShape.current = shape;
    }
    return () => { group.remove(); };
  }, [origin, routes, activeRouteId, activeStopIndex, onSelectStop, onSelectRoute, routeColorOffset, fitMaxZoom, fitPadding]);

  const hasGeometry = routes.some((route) => route.legs.some((leg) => leg.geometry.length >= 2));
  return <div className={`real-map${tileFailed && hasGeometry ? ' has-route-sketch' : ''}`} aria-label="真实路网地图"><div ref={element} className="leaflet-host" />{tileFailed && hasGeometry && <RouteSketch origin={origin} routes={routes} activeRouteId={activeRouteId} routeColorOffset={routeColorOffset} />}{(!hasGeometry || tileFailed) && <div className="map-unavailable">{tileFailed && hasGeometry ? '街道底图暂不可用；上方为路线示意。' : tileFailed ? '底图暂不可用；路线与地点清单仍可使用。' : '线路几何暂不可用，请查看地点清单。'}</div>}<div className="map-legend" aria-label="地图线路图例">{routes.map((route, index) => onSelectRoute ? <button type="button" className={route.id === activeRouteId ? 'active' : ''} aria-pressed={route.id === activeRouteId} key={route.id} onClick={() => onSelectRoute(route.id)}><i style={{ background: routeColor(index + routeColorOffset) }} />方案 {String.fromCharCode(65 + index + routeColorOffset)} · {route.title}</button> : <span className={route.id === activeRouteId ? 'active' : ''} key={route.id}><i style={{ background: routeColor(index + routeColorOffset) }} />方案 {String.fromCharCode(65 + index + routeColorOffset)} · {route.title}</span>)}</div>{routes.length > 1 && <button className="map-fit-button" type="button" onClick={() => { if (allRouteBounds.current) map.current?.fitBounds(allRouteBounds.current.pad(fitPadding), { maxZoom: fitMaxZoom }); }}>查看全部线路</button>}</div>;
}
