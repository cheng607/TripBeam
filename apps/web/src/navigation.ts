import type { Place, RouteLeg } from '@tripbeam/contracts';
import { wgsToGcj } from './map-coordinates';

const amapMode: Record<RouteLeg['mode'], string> = {
  步行: 'walk', 自行车: 'ride', 公共交通: 'bus', 打车: 'car', 自驾: 'car',
};

function amapPosition(place: Place) {
  const coordinate = wgsToGcj(place.coordinate);
  return `${coordinate.lng.toFixed(6)},${coordinate.lat.toFixed(6)},${place.label}`;
}

export function navigationUrl(from: Place, to: Place, mode: RouteLeg['mode']) {
  const params = new URLSearchParams({
    from: amapPosition(from), to: amapPosition(to), mode: amapMode[mode],
    src: 'TripBeam', callnative: '1',
  });
  return `https://uri.amap.com/navigation?${params.toString()}`;
}
