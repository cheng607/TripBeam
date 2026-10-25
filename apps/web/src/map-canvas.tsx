import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Place, TripRoute } from '@tripbeam/contracts';
import { routeColor } from './route-colors';

const coordinateSystem = import.meta.env.VITE_MAP_COORDINATE_SYSTEM ?? 'wgs84';
function wgsToGcj({ lat, lng }: { lat: number; lng: number }) {
  const x = lng - 105; const y = lat - 35;
  let dLat = -100 + 2 * x + 3 * y + .2 * y * y + .1 * x * y + .2 * Math.sqrt(Math.abs(x));
  dLat += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  dLat += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
  dLat += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
  let dLng = 300 + x + 2 * y + .1 * x * x + .1 * x * y + .1 * Math.sqrt(Math.abs(x));
  dLng += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  dLng += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
  dLng += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
  const radLat = lat / 180 * Math.PI; const magic = 1 - .00669342162296594323 * Math.sin(radLat) ** 2; const sqrtMagic = Math.sqrt(magic);
  return { lat: lat + dLat * 180 / ((6335552.717000426 / (magic * sqrtMagic)) * Math.PI), lng: lng + dLng * 180 / ((6378245 / sqrtMagic) * Math.cos(radLat) * Math.PI) };
}
const displayCoordinate = (coordinate: { lat: number; lng: number }) => coordinateSystem === 'gcj02' ? wgsToGcj(coordinate) : coordinate;
// Leaflet treats string tooltips as HTML. Labels can originate with users or
// external map providers, so keep them as text nodes throughout the map UI.
function tooltipText(value: string): HTMLElement {
  const element = document.createElement('span');
  element.textContent = value;
  return element;
}

export function MapCanvas({ origin, routes, activeRouteId, activeStopIndex, onSelectStop, onSelectRoute }: { origin: Place; routes: TripRoute[]; activeRouteId: string; activeStopIndex?: number; onSelectStop?: (index: number) => void; onSelectRoute?: (id: string) => void }) {
  const element = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const allRouteBounds = useRef<L.LatLngBounds | null>(null);
  const lastFittedShape = useRef('');
  const fitMaxZoom = onSelectRoute ? 17 : 15;
  const fitPadding = onSelectRoute ? .08 : .17;
  const [tileFailed, setTileFailed] = useState(false);
  useEffect(() => {
    if (!element.current) return;
    const displayOrigin = displayCoordinate(origin.coordinate);
    const instance = L.map(element.current, { zoomControl: true, scrollWheelZoom: false }).setView([displayOrigin.lat, displayOrigin.lng], 13);
    map.current = instance;
    const sizeObserver = new ResizeObserver(() => instance.invalidateSize());
    sizeObserver.observe(element.current);
    const tileUrl = import.meta.env.VITE_MAP_TILE_URL;
    setTileFailed(false);
    if (!tileUrl) setTileFailed(true);
    else L.tileLayer(tileUrl, { maxZoom: 19, attribution: import.meta.env.VITE_MAP_ATTRIBUTION ?? '地图数据服务商' }).on('tileerror', () => setTileFailed(true)).addTo(instance);
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
      const color = routeColor(routeIndex);
      for (const leg of route.legs) {
        const points = leg.geometry.map((coordinate) => { const point = displayCoordinate(coordinate); return [point.lat, point.lng] as L.LatLngTuple; });
        if (points.length < 2) continue;
        // A wide translucent underlay remains visible beside the focused line
        // even where two routes use the same road. The narrow core keeps each
        // non-focused route readable on its own sections.
        if (!active) L.polyline(points, { color, weight: 14, opacity: .28, interactive: false }).addTo(group);
        const line = L.polyline(points, { color, weight: active ? 7 : 4, opacity: active ? 1 : .82 }).addTo(group);
        for (const point of points) bounds.extend(point);
        line.bindTooltip(tooltipText(`${route.title} · ${leg.mode}`));
        if (onSelectRoute) line.on('click', () => onSelectRoute(route.id));
      }
      route.pois.forEach((poi, index) => {
        const displayPoi = displayCoordinate(poi.place.coordinate);
        const point: L.LatLngTuple = [displayPoi.lat, displayPoi.lng];
        bounds.extend(point);
        if (active) {
          const markerSize = onSelectRoute ? 26 : 32;
          const selected = index === activeStopIndex;
          L.marker(point, { zIndexOffset: selected ? 1_000 : 0, icon: L.divIcon({ className: `trip-marker${selected ? ' is-selected' : ''}`, html: `<span style="--marker-color:${color}">${index + 1}</span>`, iconSize: [markerSize, markerSize], iconAnchor: [markerSize / 2, markerSize / 2] }) })
            .bindTooltip(tooltipText(poi.name)).on('click', () => onSelectStop?.(index)).addTo(group);
        } else {
          const marker = L.circleMarker(point, { radius: 5, color, weight: 2, fillColor: '#fffefb', fillOpacity: .95, opacity: .85 }).bindTooltip(tooltipText(`${route.title} · ${poi.name}`)).addTo(group);
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
  }, [origin, routes, activeRouteId, activeStopIndex, onSelectStop, onSelectRoute, fitMaxZoom, fitPadding]);

  const hasGeometry = routes.some((route) => route.legs.some((leg) => leg.geometry.length >= 2));
  return <div className="real-map" aria-label="真实路网地图"><div ref={element} className="leaflet-host" />{(!hasGeometry || tileFailed) && <div className="map-unavailable">{tileFailed ? '底图暂不可用；路线与地点清单仍可使用。' : '线路几何暂不可用，请查看地点清单。'}</div>}<div className="map-legend" aria-label="地图线路图例">{routes.map((route, index) => onSelectRoute ? <button type="button" className={route.id === activeRouteId ? 'active' : ''} aria-pressed={route.id === activeRouteId} key={route.id} onClick={() => onSelectRoute(route.id)}><i style={{ background: routeColor(index) }} />方案 {String.fromCharCode(65 + index)} · {route.title}</button> : <span className={route.id === activeRouteId ? 'active' : ''} key={route.id}><i style={{ background: routeColor(index) }} />方案 {String.fromCharCode(65 + index)} · {route.title}</span>)}</div>{routes.length > 1 && <button className="map-fit-button" type="button" onClick={() => { if (allRouteBounds.current) map.current?.fitBounds(allRouteBounds.current.pad(fitPadding), { maxZoom: fitMaxZoom }); }}>查看全部线路</button>}</div>;
}
