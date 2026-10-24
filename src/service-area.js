const fs = require('node:fs');
const path = require('node:path');
const serviceArea = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'config', 'nocona-hills-service-area.geojson'),
  'utf8',
));

function pointOnSegment(point, start, end) {
  const cross = (point[1] - start[1]) * (end[0] - start[0]) -
    (point[0] - start[0]) * (end[1] - start[1]);
  if (Math.abs(cross) > 1e-8) return false;
  return point[0] >= Math.min(start[0], end[0]) - 1e-8 &&
    point[0] <= Math.max(start[0], end[0]) + 1e-8 &&
    point[1] >= Math.min(start[1], end[1]) - 1e-8 &&
    point[1] <= Math.max(start[1], end[1]) + 1e-8;
}

function isInNoconaHills(longitude, latitude) {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return false;
  const ring = serviceArea.coordinates[0];
  const point = [longitude, latitude];
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const start = ring[j];
    const end = ring[i];
    if (pointOnSegment(point, start, end)) return true;

    const crossesLatitude = (end[1] > latitude) !== (start[1] > latitude);
    if (crossesLatitude &&
        longitude < ((start[0] - end[0]) * (latitude - end[1])) /
          (start[1] - end[1]) + end[0]) {
      inside = !inside;
    }
  }
  return inside;
}

// Service calls are made within this many straight-line miles of Nocona Hills, TX.
const SERVICE_BASE = { latitude: 33.8456, longitude: -97.6399 };
const SERVICE_RADIUS_MILES = 100;

function milesFromBase(longitude, latitude) {
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const dLat = toRadians(latitude - SERVICE_BASE.latitude);
  const dLng = toRadians(longitude - SERVICE_BASE.longitude);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(SERVICE_BASE.latitude)) * Math.cos(toRadians(latitude)) * Math.sin(dLng / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isWithinServiceRadius(longitude, latitude) {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return false;
  return milesFromBase(longitude, latitude) <= SERVICE_RADIUS_MILES;
}

module.exports = { SERVICE_RADIUS_MILES, isInNoconaHills, isWithinServiceRadius, milesFromBase };
