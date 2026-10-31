export type LatLng = { lat: number; lng: number };

export function wgsToGcj({ lat, lng }: LatLng): LatLng {
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

export function displayCoordinate(coordinate: LatLng) {
  // Planner data is WGS-84. Convert exactly once when it reaches the AMap canvas.
  return wgsToGcj(coordinate);
}
